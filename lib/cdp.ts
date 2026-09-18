/**
 * CDP-based page control (like Claude in Chrome): attach chrome.debugger and use
 * Chrome's NATIVE accessibility tree + native input events — no page-side compute,
 * no getComputedStyle. Shows the "Pilot is debugging this browser" banner while
 * attached (unavoidable, accepted).
 *
 *   snapshot -> Accessibility.getFullAXTree   (roles/names computed by Chrome)
 *   click    -> DOM.getBoxModel + Input.dispatchMouseEvent (real mouse events)
 *   type     -> DOM.focus + Input.insertText
 */
const VERSION = '1.3';
const attached = new Set<number>();
const overlayReady = new Set<number>();
/** tabId -> (ref -> backendDOMNodeId) from the last snapshot. */
const refMaps = new Map<number, Map<number, number>>();

chrome.debugger?.onDetach.addListener((src) => {
  if (src.tabId != null) { attached.delete(src.tabId); overlayReady.delete(src.tabId); }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Agent-action highlight (à la Claude in Chrome / Operator): briefly box the
// element the agent is about to click/type/select using CDP's native Overlay,
// so the user can see what Pilot is doing on the page.
type ActionKind = 'click' | 'type' | 'select';
const ACTION_RGB: Record<ActionKind, [number, number, number]> = {
  click: [37, 99, 235],   // blue
  type: [22, 163, 74],    // green
  select: [217, 119, 6],  // amber
};

async function ensureOverlay(tabId: number): Promise<void> {
  if (overlayReady.has(tabId)) return;
  await send(tabId, 'Overlay.enable').catch(() => {});
  overlayReady.add(tabId);
}

export async function highlightNode(tabId: number, backendNodeId: number, kind: ActionKind): Promise<void> {
  const rgb = ACTION_RGB[kind];
  const c = (a: number) => ({ r: rgb[0], g: rgb[1], b: rgb[2], a });
  await ensureOverlay(tabId);
  await send(tabId, 'Overlay.highlightNode', {
    backendNodeId,
    highlightConfig: {
      showInfo: true,
      contentColor: c(0.18),
      borderColor: c(0.9),
      paddingColor: c(0.12),
    },
  }).catch(() => {});
}

export function hideHighlight(tabId: number): void {
  void send(tabId, 'Overlay.hideHighlight').catch(() => {});
}

function send(tabId: number, method: string, params?: object, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err && !/already attached/i.test(err.message ?? '')) reject(new Error(err.message));
      else resolve();
    });
  });
  attached.add(tabId);
  await send(tabId, 'DOM.enable').catch(() => {});
  await send(tabId, 'Accessibility.enable').catch(() => {});
}

export function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
  attached.delete(tabId);
  overlayReady.delete(tabId);
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'searchbox', 'slider',
  'option', 'spinbutton',
]);

export async function cdpSnapshot(tabId: number): Promise<{ url: string; title: string; nodes: any[] }> {
  await ensureAttached(tabId);
  const { nodes } = await send(tabId, 'Accessibility.getFullAXTree');
  const map = new Map<number, number>();
  const out: any[] = [];
  let ref = 1;
  for (const n of nodes ?? []) {
    if (n.ignored) continue;
    const role = n.role?.value;
    if (!role || !INTERACTIVE.has(role)) continue;
    if (n.backendDOMNodeId == null) continue;
    map.set(ref, n.backendDOMNodeId);
    out.push({ ref, role, label: (n.name?.value ?? '').trim(), value: n.value?.value, tag: role });
    ref++;
    if (ref > 300) break;
  }
  refMaps.set(tabId, map);
  let url = '';
  let title = '';
  try {
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: 'JSON.stringify([location.href, document.title])',
      returnByValue: true,
    });
    const parsed = JSON.parse(String(r?.result?.value ?? '["",""]'));
    url = parsed[0] ?? '';
    title = parsed[1] ?? '';
  } catch { /* ignore */ }
  return { url, title, nodes: out };
}

async function resolveBackend(tabId: number, params: Record<string, unknown>): Promise<number> {
  if (typeof params.ref === 'number') {
    const b = refMaps.get(tabId)?.get(params.ref);
    if (b == null) throw new Error(`ref ${params.ref} not found — take a browser_snapshot first`);
    return b;
  }
  if (typeof params.selector === 'string') {
    const doc = await send(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: params.selector });
    if (!nodeId) throw new Error('selector not found');
    const desc = await send(tabId, 'DOM.describeNode', { nodeId });
    return desc.node.backendNodeId;
  }
  throw new Error('need ref or selector');
}

async function centerOf(tabId: number, backendNodeId: number): Promise<{ x: number; y: number; objectId?: string }> {
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId });
  if (object?.objectId) {
    await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center",inline:"center"}); }',
    }).catch(() => {});
  }
  const box = await send(tabId, 'DOM.getBoxModel', { backendNodeId });
  const q = box?.model?.content as number[] | undefined;
  if (!q) throw new Error('element has no box (not visible)');
  return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4, objectId: object?.objectId };
}

export async function cdpClick(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const backend = await resolveBackend(tabId, params);
  const { x, y } = await centerOf(tabId, backend);
  await highlightNode(tabId, backend, 'click');
  await sleep(160);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(600);
  hideHighlight(tabId);
  return { clicked: params.ref ?? params.selector };
}

export async function cdpType(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const backend = await resolveBackend(tabId, params);
  const { objectId } = await centerOf(tabId, backend);
  await highlightNode(tabId, backend, 'type');
  await sleep(160);
  if (objectId) {
    await send(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.focus && this.focus(); if (this.select) this.select(); }',
    }).catch(() => {});
  }
  await send(tabId, 'Input.insertText', { text: String(params.text ?? '') });
  if (params.submit) {
    for (const type of ['keyDown', 'keyUp'] as const) {
      await send(tabId, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
  }
  await sleep(600);
  hideHighlight(tabId);
  return { typed: params.text };
}

export async function cdpSelectOption(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const backend = await resolveBackend(tabId, params);
  await highlightNode(tabId, backend, 'select');
  await sleep(160);
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId: backend });
  if (!object?.objectId) throw new Error('select not found');
  const r = await send(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration:
      'function(t){ const os=[...this.options]; const o=os.find(o=>o.text.trim().toLowerCase()===t.trim().toLowerCase())||os.find(o=>o.text.toLowerCase().includes(t.toLowerCase())); if(!o) throw new Error("option not found"); this.value=o.value; this.dispatchEvent(new Event("input",{bubbles:true})); this.dispatchEvent(new Event("change",{bubbles:true})); return o.text; }',
    arguments: [{ value: String(params.text ?? '') }],
    returnByValue: true,
  });
  await sleep(600);
  hideHighlight(tabId);
  return { selected: r?.result?.value };
}

export async function cdpGetText(tabId: number): Promise<unknown> {
  await ensureAttached(tabId);
  const r = await send(tabId, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
  return { text: String(r?.result?.value ?? '').slice(0, 20_000) };
}
