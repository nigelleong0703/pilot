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
  /** Element box at action time (viewport CSS px) — used to crop the thumbnail. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Viewport size at action time (CSS px). */
  viewport?: { w: number; h: number };
}

type UiMessage =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'CLEAR' }
  | { type: 'GET_STATE' }
  | { type: 'NOTE'; text: string };

type PageEvent = { type: 'USER_EVENT'; payload: Omit<RecordedStep, 'id'> };

export default defineBackground(() => {
  let isRecording = false;
  let isPaused = false;
  let recordedEvents: RecordedStep[] = [];
  let nextId = 1;
  let bridgeConnected = false;
  let promptMessage = '';

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
    isPaused = false;
    recordedEvents = [];
    nextId = 1;
    promptMessage = message;
    updateBadge();
    broadcastState();
    broadcastRecordingToTabs();
  }
  function stopRecording() {
    isRecording = false;
    isPaused = false;
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

  // captureVisibleTab is throttled (~2/s), so grab each step's shot as soon as
  // possible after the action (pre-navigation = "where I clicked") and skip if
  // we just captured or one is in flight.
  let lastShotAt = 0;
  let shotInFlight = false;
  async function captureStepScreenshot(step: RecordedStep, windowId?: number): Promise<void> {
    if (windowId == null) return;
    if (shotInFlight || Date.now() - lastShotAt < 500) return;
    shotInFlight = true;
    try {
      const shot = await captureScreenshot(windowId);
      if (shot) { step.screenshot = shot; broadcastState(); }
    } finally {
      lastShotAt = Date.now();
      shotInFlight = false;
    }
  }

  function broadcastState() {
    chrome.runtime
      .sendMessage({ type: 'STATE', isRecording, paused: isPaused, steps: recordedEvents, bridgeConnected, promptMessage })
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

  // Whole-page glow while the agent is operating the tab. Each browser command
  // refreshes it; it fades out ~6s after the last one (and is cleared when the
  // side-panel turn unpins its tab).
  const AGENT_FRAME_MS = 6000;
  function pingAgentActive(tabId?: number | null) {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { kind: 'AGENT_ACTIVE', ms: AGENT_FRAME_MS }).catch(() => {});
  }
  function clearAgentActive(tabId?: number | null) {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { kind: 'AGENT_ACTIVE', off: true }).catch(() => {});
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

  /** The tab Pilot drives: reuse the Pilot-group tab, else open a fresh one. */
  async function ensurePilotTab(): Promise<chrome.tabs.Tab> {
    const groupId = await pilotGroupId();
    if (groupId != null) {
      const tabs = await chrome.tabs.query({ groupId });
      const t = tabs.find((x) => x.id != null);
      if (t) return t;
    }
    // New Pilot tab. Open the page the user is currently viewing, so the agent
    // starts on "this page" — without touching the user's own tab.
    let url = 'about:blank';
    try {
      const active = await liveActiveTab();
      if (/^https?:/.test(active.url ?? '')) url = active.url!;
    } catch { /* keep about:blank */ }
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id != null) await groupTab(created.id);
    return created;
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

  const PAGE_METHODS = new Set([
    'navigate', 'snapshot', 'click', 'type', 'selectOption', 'getText', 'screenshot', 'replay',
  ]);

  // ── Deterministic replay ─────────────────────────────────────────────────
  // Recorded skills run as one call. Each target is tried by its saved
  // selector first, then re-found by label via a fresh snapshot — so a stale
  // selector doesn't kill the whole run.
  async function replayByLabel(tabId: number, label: unknown): Promise<Record<string, unknown>> {
    const snap = (await forwardToTab('snapshot', {}, tabId)) as { nodes?: Array<{ ref: number; label: string }> };
    const nodes = snap?.nodes ?? [];
    const want = String(label ?? '').toLowerCase();
    const hit =
      nodes.find((n) => String(n.label).toLowerCase() === want) ??
      nodes.find((n) => want && String(n.label).toLowerCase().includes(want));
    if (!hit) throw new Error(`element not found: ${label ?? '?'}`);
    return { ref: hit.ref };
  }

  /** Run one replay action, falling back from selector to label lookup. */
  async function replayAct(
    tabId: number,
    a: Record<string, unknown>,
    method: 'click' | 'type' | 'selectOption',
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (typeof a.sel === 'string' && a.sel) {
      try {
        await forwardToTab(method, { selector: a.sel, ...extra }, tabId);
        return;
      } catch { /* stale selector → try by label */ }
    }
    const t = await replayByLabel(tabId, a.el);
    await forwardToTab(method, { ...t, ...extra }, tabId);
  }

  async function runReplay(tabId: number, actions: Array<Record<string, unknown>>): Promise<unknown> {
    const results: Array<Record<string, unknown>> = [];
    for (const a of actions) {
      try {
        const act = String(a.act ?? '');
        if (act === 'navigate') {
          await chrome.tabs.update(tabId, { url: String(a.to ?? '') });
          await waitForTabComplete(tabId);
          await ensureContentScript(tabId);
        } else if (act === 'click') {
          await replayAct(tabId, a, 'click', {});
        } else if (act === 'input') {
          await replayAct(tabId, a, 'type', { text: String(a.value ?? ''), submit: !!a.submit });
        } else if (act === 'change') {
          try {
            await replayAct(tabId, a, 'selectOption', { text: String(a.value ?? '') });
          } catch {
            await replayAct(tabId, a, 'type', { text: String(a.value ?? '') });
          }
        } else {
          throw new Error(`unknown action: ${act}`);
        }
        results.push({ act, ok: true });
      } catch (e) {
        results.push({ act: String(a.act ?? ''), ok: false, error: String((e as Error)?.message ?? e) });
        break;
      }
    }
    return { results };
  }

  // ── Deep frame read/act ──────────────────────────────────────────────────
  // chrome.scripting injects into EVERY frame the extension can access,
  // including cross-origin (out-of-process) iframes that chrome.debugger's
  // per-frame query and content scripts can't reach — e.g. Google consoles.
  async function deepRead(tabId: number): Promise<{ url: string; title: string; nodes: Array<{ ref: number; role: string; label: string; tag: string }>; text: string }> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const nodes: Array<{ role: string; label: string }> = [];
          const els = document.querySelectorAll('a,button,input,select,textarea,summary,[role],[onclick],label');
          for (const el of Array.from(els)) {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const label = (
              el.getAttribute('aria-label') ||
              (el as HTMLElement).innerText ||
              el.getAttribute('placeholder') ||
              el.getAttribute('title') ||
              ''
            ).trim().slice(0, 80);
            nodes.push({ role: el.getAttribute('role') || el.tagName.toLowerCase(), label });
            if (nodes.length >= 300) break;
          }
          return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 20000), nodes };
        },
      } as any);
      let ref = 1;
      const nodes: Array<{ ref: number; role: string; label: string; tag: string }> = [];
      for (const r of results) {
        for (const n of ((r.result as any)?.nodes ?? [])) {
          nodes.push({ ref: ref++, role: n.role, label: n.label, tag: n.role });
        }
      }
      const text = results.map((r: any) => r.result?.text ?? '').filter(Boolean).join('\n');
      const first: any = results[0]?.result ?? {};
      return { url: first.url ?? '', title: first.title ?? '', nodes, text };
    } catch {
      return { url: '', title: '', nodes: [], text: '' };
    }
  }

  async function deepAct(tabId: number, action: 'click' | 'type', match: string, text = ''): Promise<boolean> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        args: [action, match, text] as any,
        func: (act: string, m: string, val: string) => {
          const want = m.toLowerCase();
          const els = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role],[onclick],label')) as HTMLElement[];
          const labelOf = (el: Element) =>
            (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().toLowerCase();
          const el = els.find((e) => labelOf(e) === want) || els.find((e) => labelOf(e).includes(want));
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          if (act === 'click') { el.click(); return true; }
          const input = el as HTMLInputElement;
          input.focus();
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
      } as any);
      return results.some((r) => r.result === true);
    } catch {
      return false;
    }
  }

  async function dispatch(req: BridgeRequest): Promise<unknown> {
    const p = req.params ?? {};
    // Any page action shows the whole-page "agent is controlling this tab" glow.
    if (PAGE_METHODS.has(req.method)) {
      resolveTab(p).then((t) => pingAgentActive(t.id)).catch(() => {});
    }
    switch (req.method) {
      case 'listTabs': {
        // Multi-tab workflows: tabs the user (or the agent) has placed in the
        // Pilot group. Falls back to the active tab so single-tab use still works.
        const tabs = await groupTabs();
        return { group: 'Pilot', tabs };
      }
      case 'replay': {
        const tab = await resolveTab(p);
        const actions = Array.isArray(p.actions) ? (p.actions as Array<Record<string, unknown>>) : [];
        return runReplay(tab.id!, actions);
      }
      case 'navigate': {
        const tab = await resolveTab(p);
        await chrome.tabs.update(tab.id!, { url: String(p.url) });
        await waitForTabComplete(tab.id!);
        await ensureContentScript(tab.id!);
        pingAgentActive(tab.id); // content script reloaded with the page
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
        // content script; finally fall back to deep all-frames scripting.
        const cdp = await pageModeIsCdp();
        const tab = await resolveTab(p);
        bglog(`dispatch ${req.method} tab=${tab.id} (cdp=${cdp})`);
        let out: any;
        if (cdp) {
          try {
            switch (req.method) {
              case 'snapshot': out = await cdpSnapshot(tab.id!); break;
              case 'click': out = await cdpClick(tab.id!, p); break;
              case 'type': out = await cdpType(tab.id!, p); break;
              case 'selectOption': out = await cdpSelectOption(tab.id!, p); break;
              case 'getText': out = await cdpGetText(tab.id!); break;
            }
            bglog(`cdp ${req.method} ok`);
          } catch (err) {
            bglog(`cdp ${req.method} FAILED: ${(err as Error)?.message} — falling back to DOM`);
            out = undefined;
          }
        }
        if (out === undefined) {
          try {
            out = await forwardToTab(req.method, p, tab.id);
            bglog(`dom ${req.method} ok`);
          } catch (err) {
            bglog(`dom ${req.method} FAILED: ${(err as Error)?.message}`);
            out = undefined;
          }
        }
        // Deep fallback across ALL frames (reaches cross-origin iframes).
        if (req.method === 'snapshot' && !((out?.nodes ?? []).length)) {
          return { ...(await deepRead(tab.id!)), viaFrames: true };
        }
        if (req.method === 'getText') {
          const deep = await deepRead(tab.id!);
          if (deep.text.trim()) return { text: deep.text.slice(0, 40000), viaFrames: true };
          return { text: String(out?.text ?? '') };
        }
        if ((req.method === 'click' || req.method === 'type' || req.method === 'selectOption') && out === undefined) {
          const match = String(
            req.method === 'type' ? (p.match ?? p.label ?? '') : (p.text ?? p.match ?? p.label ?? ''),
          );
          if (match && (await deepAct(tab.id!, req.method === 'click' ? 'click' : 'type', match, String(p.text ?? '')))) {
            return { viaFrames: true, [req.method]: match };
          }
          throw new Error(`${req.method}: element not found (take a snapshot or pass \`text\`)`);
        }
        if (out === undefined) throw new Error(`${req.method}: no result`);
        return out;
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
      // Pilot works in its OWN tab (reused across the session), so the turn
      // never hijacks whatever tab the user is currently on.
      ensurePilotTab()
        .then(async (t) => {
          pinnedTabId = t.id ?? null;
          if (t.id != null) await groupTab(t.id);
          sendResponse({ tabId: t.id ?? null, url: t.url ?? '', title: t.title ?? '' });
        })
        .catch(() => sendResponse({ url: '', title: '' }));
      return true; // async response
    }
    if ((message as { type?: string }).type === 'UNPIN_TAB') {
      // Keep the Pilot tab pinned for the whole session (like the tab group);
      // just stop the "controlling" glow. A new chat clears the pin.
      clearAgentActive(pinnedTabId);
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
        case 'PAUSE':    isPaused = true;  broadcastState(); sendResponse({ ok: true, paused: isPaused }); return;
        case 'RESUME':   isPaused = false; broadcastState(); sendResponse({ ok: true, paused: isPaused }); return;
        case 'CLEAR':    clearRecording(); sendResponse({ ok: true });              return;
        case 'GET_STATE':
          sendResponse({ ok: true, isRecording, paused: isPaused, steps: recordedEvents, bridgeConnected, promptMessage });
          return;
        case 'NOTE': {
          if (isRecording && !isPaused) {
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
      if (isRecording && !isPaused) {
        const ev = message as PageEvent;
        const windowId = sender.tab?.windowId;
        const step: RecordedStep = { id: nextId++, ...ev.payload };
        recordedEvents.push(step);
        recordedEvents.sort((a, b) => a.id - b.id);
        broadcastState();
        void captureStepScreenshot(step, windowId);
      }
      sendResponse({ ok: true, recording: isRecording });
      return;
    }
  });
});
