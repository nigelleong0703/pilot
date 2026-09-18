import { defineBackground } from 'wxt/sandbox';
import {
  type BridgeRequest,
  type PageCommand,
  type PageMethod,
} from '../lib/protocol';
import { cdpSnapshot, cdpClick, cdpType, cdpSelectOption, cdpGetText, detach as cdpDetach } from '../lib/cdp';

export interface RecordedStep {
  id: number;
  type: 'click' | 'input' | 'change' | 'submit' | 'navigate' | 'note';
  label: string;
  value?: string;
  selector: string;
  url: string;
  ts: number;
  screenshot?: string;
}

type UiMessage =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'CLEAR' }
  | { type: 'GET_STATE' }
  | { type: 'NOTE'; text: string };

type PageEvent = { type: 'USER_EVENT'; payload: Omit<RecordedStep, 'id'> };

export default defineBackground(() => {
  let isRecording = false;
  let recordedEvents: RecordedStep[] = [];
  let nextId = 1;
  let bridgeConnected = false;
  let promptMessage = '';

  const POST_ACTION_DELAY_MS = 500;

  function updateBadge() {
    const action = chrome.action;
    if (!action) return;
    if (isRecording) {
      action.setBadgeText({ text: 'REC' });
      action.setBadgeBackgroundColor({ color: '#dc2626' });
    } else if (bridgeConnected) {
      action.setBadgeText({ text: 'ON' });
      action.setBadgeBackgroundColor({ color: '#16a34a' });
    } else {
      action.setBadgeText({ text: '' });
    }
    action.setBadgeTextColor?.({ color: '#ffffff' });
  }

  async function broadcastRecordingToTabs() {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs
        .sendMessage(t.id, { kind: 'RECORDING_STATE', recording: isRecording })
        .catch(() => {});
    }
  }

  function startRecording(message = '') {
    isRecording = true;
    recordedEvents = [];
    nextId = 1;
    promptMessage = message;
    updateBadge();
    broadcastState();
    broadcastRecordingToTabs();
  }
  function stopRecording() {
    isRecording = false;
    promptMessage = '';
    updateBadge();
    broadcastState();
    broadcastRecordingToTabs();
  }
  function clearRecording() {
    recordedEvents = [];
    nextId = 1;
    broadcastState();
  }

  async function captureScreenshot(windowId?: number): Promise<string | undefined> {
    if (windowId == null) return undefined;
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
    } catch {
      return undefined;
    }
  }

  function broadcastState() {
    chrome.runtime
      .sendMessage({ type: 'STATE', isRecording, steps: recordedEvents, bridgeConnected, promptMessage })
      .catch(() => {});
  }

  // ── Toolbar / side panel ────────────────────────────────────────────────
  chrome.action?.onClicked.addListener(async (tab) => {
    if (chrome.sidePanel && tab.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  });
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

  // ════════════════════════════════════════════════════════════════════════
  // Bridge connection — the OFFSCREEN document owns the WebSocket to the daemon.
  // Offscreen documents persist independently of the service worker, so the
  // connection no longer dies when the SW is reaped (that was the root of the
  // crashes). The SW only EXECUTES browser commands (CDP / tabs) on demand,
  // relayed from the offscreen doc; it can sleep freely between commands.
  //   daemon --ws:9234--> offscreen --EXEC--> SW (CDP/tabs) --> reply --> offscreen
  // ════════════════════════════════════════════════════════════════════════
  async function ensureOffscreen() {
    if (typeof chrome.offscreen?.createDocument !== 'function') return;
    try {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Holds the persistent WebSocket bridge to the local agent daemon',
      });
    } catch { /* unavailable or already exists */ }
  }

  function setBridge(connected: boolean) {
    if (bridgeConnected !== connected) { bridgeConnected = connected; updateBadge(); broadcastState(); }
  }

  /** Diagnostic log line → offscreen → daemon (~/.pilot/daemon.log). */
  function bglog(msg: string) {
    chrome.runtime.sendMessage({ kind: 'ACP_SEND', payload: { type: 'acp/log', msg } }).catch(() => {});
  }

  ensureOffscreen();
  // Recreate the offscreen doc if it ever goes away (it normally persists).
  chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'bridge-keepalive') ensureOffscreen();
  });

  // ── Target the user's active tab (or the pinned tab during a turn) ───────
  // Pilot drives the page you're looking at. While a turn is running we PIN the
  // tab it started on, so switching tabs mid-task can't redirect its actions to
  // the wrong page. Between turns we fall back to the live active tab.
  let pinnedTabId: number | null = null;

  // ── Tab grouping (persistent per-session group, à la Claude) ──────────────
  // The tab(s) Pilot works with live in a colored "Pilot" group in the tab
  // strip for the whole chat session (not just the turn). Users can drag more
  // tabs in to work across them (multi-tab workflows). A new chat clears the
  // group so the next session starts clean.
  const GROUP_TITLE = 'Pilot';
  const GROUP_COLOR = 'blue';

  async function pilotGroupId(): Promise<number | null> {
    try {
      if (typeof chrome.tabGroups?.query !== 'function') return null;
      const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
      return groups[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  async function groupTab(tabId: number) {
    try {
      if (typeof chrome.tabs.group !== 'function') return;
      let groupId = await pilotGroupId();
      if (groupId == null) {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
        await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
      } else {
        await chrome.tabs.group({ tabIds: [tabId], groupId });
      }
    } catch { /* tabGroups unavailable (Firefox etc.) */ }
  }

  /** All tabs currently in the Pilot group (the agent's multi-tab workspace). */
  async function groupTabs(): Promise<Array<{ tabId: number; url: string; title: string; active: boolean }>> {
    const groupId = await pilotGroupId();
    if (groupId == null) {
      try {
        const t = await getActiveTab();
        return [{ tabId: t.id ?? -1, url: t.url ?? '', title: t.title ?? '', active: true }];
      } catch { return []; }
    }
    const tabs = await chrome.tabs.query({ groupId });
    return (tabs ?? [])
      .filter((t) => t.id != null)
      .map((t) => ({ tabId: t.id!, url: t.url ?? '', title: t.title ?? '', active: !!t.active }));
  }

  /** Remove every tab from the Pilot group (called on a new chat). */
  async function clearPilotGroup() {
    const groupId = await pilotGroupId();
    if (groupId == null) return;
    try {
      if (typeof chrome.tabs.ungroup !== 'function') return;
      const tabs = await chrome.tabs.query({ groupId });
      await chrome.tabs.ungroup((tabs ?? []).map((t) => t.id).filter((x): x is number => x != null));
    } catch { /* ignore */ }
  }

  /** The tab the user is actually looking at (ignores any pin). */
  async function liveActiveTab(): Promise<chrome.tabs.Tab> {
    // Prefer the last-focused NORMAL browser window's active tab (excludes the
    // side panel, devtools, popups). This is what fixes "no active tab".
    try {
      const win = await chrome.windows.getLastFocused({ populate: true });
      if (win?.type === 'normal') {
        const t = win.tabs?.find((x) => x.active);
        if (t?.id != null) return t;
      }
    } catch { /* fall through */ }
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (!tab || tab.id == null) {
      const wins = await chrome.tabs.query({ active: true, windowType: 'normal' });
      tab = wins.find((t) => t.id != null && /^https?:/.test(t.url ?? '')) ?? wins[0];
    }
    if (!tab || tab.id == null) tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    return tab;
  }

  /** The tab Pilot should act on: the pinned one during a turn, else the live active tab. */
  async function getActiveTab(): Promise<chrome.tabs.Tab> {
    if (pinnedTabId != null) {
      try { return await chrome.tabs.get(pinnedTabId); } catch { pinnedTabId = null; }
    }
    return liveActiveTab();
  }

  // Tell the side panel which tab is active so its chip stays in sync.
  function broadcastActiveTab(tab: { id?: number; url?: string; title?: string }) {
    if (pinnedTabId != null) return; // during a turn the chip shows the pinned tab
    chrome.runtime
      .sendMessage({ type: 'ACTIVE_TAB', tabId: tab.id ?? null, url: tab.url ?? '', title: tab.title ?? '' })
      .catch(() => {});
  }
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try { broadcastActiveTab(await chrome.tabs.get(tabId)); } catch { /* gone */ }
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if ((info.url || info.title || info.status === 'complete') && tab.active) broadcastActiveTab(tab);
  });
  chrome.tabs.onRemoved.addListener((tabId) => cdpDetach(tabId));

  function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (id: number, info: { status?: string }) => {
        if (id === tabId && info.status === 'complete') finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs
        .get(tabId)
        .then((t) => { if (t.status === 'complete') finish(); })
        .catch(() => finish());
    });
  }

  async function ensureContentScript(tabId: number) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/content.js'],
      });
    } catch {
      // chrome://, edge:// pages can't be injected — caller surfaces the error.
    }
  }

  async function sendToTab(tabId: number, cmd: PageCommand) {
    const res = (await chrome.tabs.sendMessage(tabId, cmd)) as
      | { ok: boolean; result?: unknown; error?: string }
      | undefined;
    if (!res) throw new Error('No response from content script');
    if (!res.ok) throw new Error(res.error || 'Command failed');
    return res.result;
  }

  async function forwardToTab(
    method: PageMethod,
    params?: Record<string, unknown>,
    tabId?: number,
  ) {
    const tab = tabId != null ? await chrome.tabs.get(tabId) : await getActiveTab();
    const cmd: PageCommand = { kind: 'COMMAND', method, params };
    try {
      return await sendToTab(tab.id!, cmd);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes('Receiving end does not exist') || msg.includes('No response')) {
        await ensureContentScript(tab.id!);
        await new Promise((r) => setTimeout(r, 350));
        return await sendToTab(tab.id!, cmd);
      }
      throw err;
    }
  }

  async function pageModeIsCdp(): Promise<boolean> {
    try {
      const r = await chrome.storage.local.get('pilot.settings');
      // CDP (native a11y tree + input events) is the default — like Claude in
      // Chrome, it shows a debugger banner while attached. DOM is opt-in.
      return r['pilot.settings']?.pageMode !== 'dom';
    } catch {
      return true;
    }
  }

  /** Resolve the tab a command targets: explicit tabId wins, else the active/pinned tab. */
  async function resolveTab(params: Record<string, unknown>): Promise<chrome.tabs.Tab> {
    if (typeof params.tabId === 'number') {
      try { return await chrome.tabs.get(params.tabId); } catch { /* fall through */ }
    }
    return getActiveTab();
  }

  async function dispatch(req: BridgeRequest): Promise<unknown> {
    const p = req.params ?? {};
    switch (req.method) {
      case 'listTabs': {
        // Multi-tab workflows: tabs the user (or the agent) has placed in the
        // Pilot group. Falls back to the active tab so single-tab use still works.
        const tabs = await groupTabs();
        return { group: 'Pilot', tabs };
      }
      case 'navigate': {
        const tab = await resolveTab(p);
        await chrome.tabs.update(tab.id!, { url: String(p.url) });
        await waitForTabComplete(tab.id!);
        await ensureContentScript(tab.id!);
        return { navigatedTo: p.url, tabId: tab.id };
      }
      case 'pageContext': {
        const tab = await resolveTab(p);
        return { url: tab.url ?? '', title: tab.title ?? '' };
      }
      case 'screenshot': {
        const tab = await resolveTab(p);
        const dataUrl = await captureScreenshot(tab.windowId);
        if (!dataUrl) throw new Error('Screenshot failed');
        return { dataUrl };
      }
      case 'snapshot':
      case 'click':
      case 'type':
      case 'selectOption':
      case 'getText': {
        // Prefer CDP (native a11y tree + input events); fall back to the
        // content script if the debugger can't attach or a call fails.
        const cdp = await pageModeIsCdp();
        const tab = await resolveTab(p);
        bglog(`dispatch ${req.method} tab=${tab.id} (cdp=${cdp})`);
        if (cdp) {
          try {
            let out: unknown;
            switch (req.method) {
              case 'snapshot': out = await cdpSnapshot(tab.id!); break;
              case 'click': out = await cdpClick(tab.id!, p); break;
              case 'type': out = await cdpType(tab.id!, p); break;
              case 'selectOption': out = await cdpSelectOption(tab.id!, p); break;
              case 'getText': out = await cdpGetText(tab.id!); break;
            }
            bglog(`cdp ${req.method} ok`);
            return out;
          } catch (err) {
            bglog(`cdp ${req.method} FAILED: ${(err as Error)?.message} — falling back to DOM`);
          }
        }
        bglog(`dom ${req.method} start`);
        const r = await forwardToTab(req.method, p, tab.id);
        bglog(`dom ${req.method} ok`);
        return r;
      }

      case 'recorder.start':    startRecording(String(p.message ?? ''));  return { isRecording };
      case 'recorder.stop':     stopRecording();   return { isRecording, count: recordedEvents.length };
      case 'recorder.clear':    clearRecording();  return { ok: true };
      case 'recorder.getSteps': return { isRecording, steps: recordedEvents };

      default: throw new Error(`Unknown method: ${req.method}`);
    }
  }

  // ── Message router ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((
    message: UiMessage | PageEvent | { type: 'PAGE_HELLO' } | Record<string, unknown>,
    sender,
    sendResponse,
  ) => {
    // ── Browser command relayed from the offscreen doc → execute via CDP/tabs ──
    if ((message as { kind?: string }).kind === 'EXEC') {
      const req = (message as { req: BridgeRequest }).req;
      dispatch(req)
        .then((result) => sendResponse({ id: req.id, ok: true, result }))
        .catch((err) => sendResponse({ id: req.id, ok: false, error: String((err as Error)?.message ?? err) }));
      return true; // async response
    }

    // ── Connection status pushed by the offscreen doc ──
    if ((message as { kind?: string }).kind === 'BRIDGE_STATUS') {
      setBridge(!!(message as { connected?: boolean }).connected);
      return;
    }

    // ── Side panel asks what page the user is currently on ──
    if ((message as { type?: string }).type === 'GET_PAGE_CONTEXT') {
      liveActiveTab()
        .then((t) => sendResponse({ tabId: t.id ?? null, url: t.url ?? '', title: t.title ?? '' }))
        .catch(() => sendResponse({ url: '', title: '' }));
      return true; // async response
    }

    // ── Pin the current tab for the duration of a turn ──
    if ((message as { type?: string }).type === 'PIN_TAB') {
      liveActiveTab()
        .then(async (t) => {
          pinnedTabId = t.id ?? null;
          // Persistent per-session group: the tab stays in the Pilot group
          // after the turn ends (Claude-style) until a new chat clears it.
          if (t.id != null) await groupTab(t.id);
          sendResponse({ tabId: t.id ?? null, url: t.url ?? '', title: t.title ?? '' });
        })
        .catch(() => sendResponse({ url: '', title: '' }));
      return true; // async response
    }
    if ((message as { type?: string }).type === 'UNPIN_TAB') {
      pinnedTabId = null;
      liveActiveTab().then((t) => broadcastActiveTab(t)).catch(() => {});
      return;
    }
    // ── A new chat starts: clear the Pilot tab group for a fresh session ──
    if ((message as { type?: string }).type === 'CLEAR_PILOT_GROUP') {
      pinnedTabId = null;
      void clearPilotGroup();
      return;
    }

    // ── From extension UI (side panel) ──
    const fromExtensionUi =
      sender.url?.startsWith('chrome-extension://') ||
      sender.url?.startsWith('moz-extension://') ||
      (sender.tab == null && (message as { type?: string }).type !== 'USER_EVENT');

    if (fromExtensionUi) {
      switch ((message as UiMessage).type) {
        case 'START':    startRecording(); sendResponse({ ok: true, isRecording }); return;
        case 'STOP':     stopRecording();  sendResponse({ ok: true, isRecording }); return;
        case 'CLEAR':    clearRecording(); sendResponse({ ok: true });              return;
        case 'GET_STATE':
          sendResponse({ ok: true, isRecording, steps: recordedEvents, bridgeConnected, promptMessage });
          return;
        case 'NOTE': {
          if (isRecording) {
            const noteMsg = message as { type: 'NOTE'; text: string };
            const step: RecordedStep = {
              id: nextId++,
              type: 'note',
              label: noteMsg.text,
              selector: '',
              url: '',
              ts: Date.now(),
            };
            recordedEvents.push(step);
            broadcastState();
          }
          sendResponse({ ok: true });
          return;
        }
      }
    }

    // ── From page content scripts ──
    if ((message as { type: string }).type === 'PAGE_HELLO') {
      sendResponse({ recording: isRecording });
      return;
    }

    if ((message as PageEvent).type === 'USER_EVENT') {
      if (isRecording) {
        const ev = message as PageEvent;
        const windowId = sender.tab?.windowId;
        const tabId    = sender.tab?.id;
        const step: RecordedStep = { id: nextId++, ...ev.payload };
        recordedEvents.push(step);
        recordedEvents.sort((a, b) => a.id - b.id);
        broadcastState();
        setTimeout(async () => {
          if (tabId != null) {
            try { await waitForTabComplete(tabId, 4000); } catch { /* ignore */ }
          }
          const screenshot = await captureScreenshot(windowId);
          if (screenshot) { step.screenshot = screenshot; broadcastState(); }
        }, POST_ACTION_DELAY_MS);
      }
      sendResponse({ ok: true, recording: isRecording });
      return;
    }
  });
});
