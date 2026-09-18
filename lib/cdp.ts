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
import { paintAgentCursor } from './overlay';

const VERSION = '1.3';
const attached = new Set<number>();
/** tabId -> (ref -> backendDOMNodeId) from the last snapshot. */
const refMaps = new Map<number, Map<number, number>>();

chrome.debugger?.onDetach.addListener((src) => {
  if (src.tabId != null) attached.delete(src.tabId);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ActionKind = 'click' | 'type' | 'select';

/**
 * Agent-action visual (à la Claude in Chrome / Operator): an on-page cursor
 * glides to the element and clicks, with a glowing halo around the target. It's
 * injected into the page (not CDP's native Overlay) so it's visible and also
 * shows up in screenshots. Uses the self-contained paintAgentCursor source so
 * the CDP and content-script paths render it identically. Colors: click=blue,
 * type=green, select=amber.
 */
const OVERLAY_FN = `(${paintAgentCursor.toString()})`;

async function showCursor(tabId: number, box: { x: number; y: number; width: number; height: number }, kind: ActionKind): Promise<void> {
  await send(tabId, 'Runtime.evaluate', {
    expression: `${OVERLAY_FN}(${JSON.stringify(box)},${JSON.stringify(kind)})`,
  }).catch(() => {});
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

async function centerOf(tabId: number, backendNodeId: number): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number }; objectId?: string }> {
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
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const x1 = Math.max(...xs), y1 = Math.max(...ys);
  return {
    x: (x0 + x1) / 2,
    y: (y0 + y1) / 2,
    box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    objectId: object?.objectId,
  };
}

export async function cdpClick(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const backend = await resolveBackend(tabId, params);
  const { x, y, box } = await centerOf(tabId, backend);
  await showCursor(tabId, box, 'click');
  await sleep(300); // let the on-page cursor glide to the target first
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(500);
  return { clicked: params.ref ?? params.selector };
}

export async function cdpType(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const backend = await resolveBackend(tabId, params);
  const { box, objectId } = await centerOf(tabId, backend);
  await showCursor(tabId, box, 'type');
  await sleep(300);
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
  await sleep(400);
  return { typed: params.text };
}

export async function cdpSelectOption(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const backend = await resolveBackend(tabId, params);
  const { box } = await centerOf(tabId, backend);
  await showCursor(tabId, box, 'select');
  await sleep(300);
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId: backend });
  if (!object?.objectId) throw new Error('select not found');
  const r = await send(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration:
      'function(t){ const os=[...this.options]; const o=os.find(o=>o.text.trim().toLowerCase()===t.trim().toLowerCase())||os.find(o=>o.text.toLowerCase().includes(t.toLowerCase())); if(!o) throw new Error("option not found"); this.value=o.value; this.dispatchEvent(new Event("input",{bubbles:true})); this.dispatchEvent(new Event("change",{bubbles:true})); return o.text; }',
    arguments: [{ value: String(params.text ?? '') }],
    returnByValue: true,
  });
  await sleep(400);
  return { selected: r?.result?.value };
}

export async function cdpGetText(tabId: number): Promise<unknown> {
  await ensureAttached(tabId);
  const r = await send(tabId, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
  return { text: String(r?.result?.value ?? '').slice(0, 20_000) };
}
