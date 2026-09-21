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
  if (src.tabId != null) {
    attached.delete(src.tabId);
    consoleLog.delete(src.tabId);
    netLog.delete(src.tabId);
  }
});

// ── Console + network recording ────────────────────────────────────────────
// CDP pushes these as events, so we keep a small ring buffer per tab and let
// cdpConsole/cdpNetwork read it back. Only what happened WHILE attached is
// visible — reload the page to capture load-time errors.
export interface ConsoleEntry { t: number; level: string; text: string; url?: string; line?: number }
export interface NetEntry { t: number; method: string; url: string; status?: number; type?: string; error?: string; ms?: number }
const LOG_CAP = 200;
const consoleLog = new Map<number, ConsoleEntry[]>();
const netLog = new Map<number, NetEntry[]>();
/** requestId -> the entry being filled in, per tab. */
const netPending = new Map<number, Map<string, NetEntry>>();

function push<T>(map: Map<number, T[]>, tabId: number, entry: T) {
  const list = map.get(tabId) ?? [];
  list.push(entry);
  if (list.length > LOG_CAP) list.splice(0, list.length - LOG_CAP);
  map.set(tabId, list);
}

/** One console argument, flattened to a short string. */
function argText(a: any): string {
  if (a == null) return '';
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return String(a.description ?? a.unserializableValue ?? a.type ?? '');
}

chrome.debugger?.onEvent.addListener((src, method, params: any) => {
  const tabId = src.tabId;
  if (tabId == null || !params) return;
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const frame = params.stackTrace?.callFrames?.[0];
      push(consoleLog, tabId, {
        t: Date.now(),
        level: String(params.type ?? 'log'),
        text: (params.args ?? []).map(argText).join(' ').slice(0, 2000),
        url: frame?.url,
        line: frame?.lineNumber != null ? frame.lineNumber + 1 : undefined,
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails ?? {};
      push(consoleLog, tabId, {
        t: Date.now(),
        level: 'error',
        text: String(d.exception?.description ?? d.text ?? 'exception').slice(0, 2000),
        url: d.url,
        line: d.lineNumber != null ? d.lineNumber + 1 : undefined,
      });
      break;
    }
    case 'Log.entryAdded': {
      // Where "Failed to load resource: 401" and other browser-level messages live.
      const e = params.entry ?? {};
      push(consoleLog, tabId, {
        t: Date.now(),
        level: String(e.level ?? 'info'),
        text: String(e.text ?? '').slice(0, 2000),
        url: e.url,
        line: e.lineNumber != null ? e.lineNumber + 1 : undefined,
      });
      break;
    }
    case 'Network.requestWillBeSent': {
      const entry: NetEntry = {
        t: Date.now(),
        method: String(params.request?.method ?? 'GET'),
        url: String(params.request?.url ?? '').slice(0, 500),
        type: params.type,
      };
      let pend = netPending.get(tabId);
      if (!pend) { pend = new Map(); netPending.set(tabId, pend); }
      pend.set(String(params.requestId), entry);
      push(netLog, tabId, entry);
      break;
    }
    case 'Network.responseReceived': {
      const e = netPending.get(tabId)?.get(String(params.requestId));
      if (e) { e.status = params.response?.status; e.type = params.type ?? e.type; }
      break;
    }
    case 'Network.loadingFailed': {
      const e = netPending.get(tabId)?.get(String(params.requestId));
      if (e) e.error = String(params.errorText ?? 'failed');
      break;
    }
    case 'Network.loadingFinished': {
      const pend = netPending.get(tabId);
      const e = pend?.get(String(params.requestId));
      if (e) { e.ms = Date.now() - e.t; pend!.delete(String(params.requestId)); }
      break;
    }
  }
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
  await send(tabId, 'Page.enable').catch(() => {});
  // Console + network recording: enabled on attach so a later browser_console /
  // browser_network call has history to show, without a separate "start" step.
  await send(tabId, 'Runtime.enable').catch(() => {});
  await send(tabId, 'Log.enable').catch(() => {});
  await send(tabId, 'Network.enable', { maxPostDataSize: 0 }).catch(() => {});
}

export function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
  attached.delete(tabId);
  consoleLog.delete(tabId);
  netLog.delete(tabId);
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'searchbox', 'slider',
  'option', 'spinbutton',
]);

export interface SnapshotOpts {
  /** CSS selector — only return elements inside this container. */
  scope?: string;
  /** Case-insensitive substring; keeps nodes whose label or role matches. */
  filter?: string;
  /** Max nodes to return (default 200). */
  limit?: number;
}

export async function cdpSnapshot(
  tabId: number,
  opts: SnapshotOpts = {},
): Promise<{ url: string; title: string; nodes: any[]; total: number; truncated: boolean }> {
  await ensureAttached(tabId);
  // Main frame + every iframe (many apps — e.g. Google consoles — render in frames),
  // or just one container's subtree when `scope` is given.
  let all: any[] = [];
  if (opts.scope) {
    const backendNodeId = await resolveBackend(tabId, { selector: opts.scope });
    const r = await send(tabId, 'Accessibility.queryAXTree', { backendNodeId }).catch(() => null);
    all = r?.nodes ?? [];
  } else {
  const main = await send(tabId, 'Accessibility.getFullAXTree').catch(() => null);
  all = all.concat(main?.nodes ?? []);
  for (const frameId of await frameIds(tabId)) {
    const r = await send(tabId, 'Accessibility.getFullAXTree', { frameId }).catch(() => null);
    all = all.concat(r?.nodes ?? []);
  }
  }
  const seen = new Set<string>();
  const map = new Map<number, number>();
  const out: any[] = [];
  const needle = opts.filter?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 500));
  let ref = 1;
  let total = 0;
  for (const n of all) {
    if (!n || n.ignored) continue;
    if (n.nodeId && seen.has(n.nodeId)) continue;
    if (n.nodeId) seen.add(n.nodeId);
    const role = n.role?.value;
    if (!role || !INTERACTIVE.has(role)) continue;
    if (n.backendDOMNodeId == null) continue;
    const label = (n.name?.value ?? '').trim();
    if (needle && !label.toLowerCase().includes(needle) && !role.toLowerCase().includes(needle)) continue;
    total++;
    if (out.length >= limit) continue;
    // Chrome exposes a link's target as an AX property — free, so include it.
    const url = n.properties?.find((q: any) => q.name === 'url')?.value?.value;
    map.set(ref, n.backendDOMNodeId);
    out.push({
      ref, role, label, value: n.value?.value, tag: role,
      ...(url ? { href: String(url).slice(0, 200) } : {}),
    });
    ref++;
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
  return { url, title, nodes: out, total, truncated: total > out.length };
}

/** Ids of all child frames (any depth) of the main frame. */
async function frameIds(tabId: number): Promise<string[]> {
  try {
    const { frameTree } = await send(tabId, 'Page.getFrameTree');
    const ids: string[] = [];
    const walk = (f: any) => { for (const c of f.childFrames ?? []) { ids.push(c.frame.id); walk(c); } };
    walk(frameTree);
    return ids;
  } catch {
    return [];
  }
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

/** Click at a viewport coordinate (vision/coordinate fallback when the DOM/a11y
 *  can't identify the element — canvas, exotic SPAs, cross-origin UI). */
export async function cdpClickAt(tabId: number, x: number, y: number): Promise<unknown> {
  await ensureAttached(tabId);
  await showCursor(tabId, { x: x - 11, y: y - 11, width: 22, height: 22 }, 'click');
  await sleep(200);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(400);
  return { clickedAt: { x, y } };
}

/** Type text into whatever is focused (pair with cdpClickAt for coordinate flows). */
export async function cdpTypeText(tabId: number, text: string, submit = false): Promise<unknown> {
  await ensureAttached(tabId);
  await send(tabId, 'Input.insertText', { text });
  if (submit) {
    for (const type of ['keyDown', 'keyUp'] as const) {
      await send(tabId, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
  }
  return { typed: text };
}

/** Named keys we know the code/keyCode for. Anything else falls back to the
 *  single-character rules below (letters, digits, punctuation). */
const KEY_DEFS: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  Space: { key: ' ', code: 'Space', vk: 32 },
};

/** CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) + the modifier keys
 *  themselves, which must be pressed around the chord for the page to see a
 *  real Ctrl+K rather than a lone "k". */
const MODIFIERS: Record<string, { bit: number; key: string; code: string; vk: number }> = {
  alt:     { bit: 1, key: 'Alt',     code: 'AltLeft',     vk: 18 },
  option:  { bit: 1, key: 'Alt',     code: 'AltLeft',     vk: 18 },
  ctrl:    { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  meta:    { bit: 4, key: 'Meta',    code: 'MetaLeft',    vk: 91 },
  cmd:     { bit: 4, key: 'Meta',    code: 'MetaLeft',    vk: 91 },
  command: { bit: 4, key: 'Meta',    code: 'MetaLeft',    vk: 91 },
  shift:   { bit: 8, key: 'Shift',   code: 'ShiftLeft',   vk: 16 },
};

/** Split "Control+Shift+K" into its modifiers and the key they apply to. */
function parseChord(spec: string) {
  const parts = spec.split('+').map((s) => s.trim()).filter(Boolean);
  // A trailing "+" means the key IS "+" (e.g. "Control++").
  const last = parts.length ? parts[parts.length - 1]! : 'Enter';
  const mods = parts.slice(0, -1);
  const seen = new Map<string, { bit: number; key: string; code: string; vk: number }>();
  let mask = 0;
  for (const m of mods) {
    const def = MODIFIERS[m.toLowerCase()];
    if (!def) continue;
    if (!seen.has(def.key)) { seen.set(def.key, def); mask |= def.bit; }
  }
  let main = KEY_DEFS[last];
  if (!main && last.length === 1) {
    const ch = last;
    const upper = ch.toUpperCase();
    const code = /[a-z]/i.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : '';
    main = { key: ch, code, vk: upper.charCodeAt(0) };
  }
  return { mods: [...seen.values()], mask, main: main ?? { key: last, code: last, vk: 0 } };
}

/** Press a key or a CHORD: "Enter", "Escape", "Control+k", "Meta+Shift+P".
 *  Modifier keys are pressed and released around the key, and the modifier
 *  bitmask rides on the event, so page-level hotkey handlers fire. */
export async function cdpKey(tabId: number, spec: string): Promise<unknown> {
  await ensureAttached(tabId);
  const { mods, mask, main } = parseChord(spec);
  for (const m of mods) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: m.key, code: m.code,
      windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: mask,
    });
  }
  // `text` makes a printable key actually insert a character — but only when no
  // Ctrl/Meta is held, otherwise Chrome treats the chord as a command, not input.
  const printable = main.key.length === 1 && !(mask & 2) && !(mask & 4);
  const base = {
    key: main.key, code: main.code,
    windowsVirtualKeyCode: main.vk, nativeVirtualKeyCode: main.vk, modifiers: mask,
    ...(printable ? { text: main.key } : {}),
  };
  await send(tabId, 'Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  for (const m of [...mods].reverse()) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: m.key, code: m.code,
      windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: 0,
    });
  }
  await sleep(150);
  return { pressed: spec, modifiers: mods.map((m) => m.key), key: main.key };
}

/** Scroll the page with a wheel event, or scroll ONE container when `selector`
 *  / `ref` is given — needed for modals, virtualised lists and any page that
 *  locks body scroll, where a page-level wheel event moves nothing. */
export async function cdpScroll(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  await ensureAttached(tabId);
  const dy = Number(params.dy ?? 0);
  const dx = Number(params.dx ?? 0);
  const to = typeof params.to === 'string' ? params.to : undefined;

  if (params.selector != null || params.ref != null) {
    const backend = await resolveBackend(tabId, params);
    const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId: backend });
    if (!object?.objectId) throw new Error('scroll target not found');
    const r = await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function(dx,dy,to){ if(to==="top") this.scrollTop=0; else if(to==="bottom") this.scrollTop=this.scrollHeight; else { this.scrollTop+=dy; this.scrollLeft+=dx; } return {scrollTop:this.scrollTop,scrollLeft:this.scrollLeft,scrollHeight:this.scrollHeight,clientHeight:this.clientHeight}; }',
      arguments: [{ value: dx }, { value: dy }, { value: to ?? '' }],
      returnByValue: true,
    });
    await sleep(150);
    return { scrolled: params.selector ?? `ref ${params.ref}`, ...(r?.result?.value ?? {}) };
  }

  if (to) {
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: `(()=>{const el=document.scrollingElement||document.documentElement;el.scrollTop=${to === 'bottom' ? 'el.scrollHeight' : '0'};return {scrollTop:el.scrollTop,scrollHeight:el.scrollHeight};})()`,
      returnByValue: true,
    });
    await sleep(150);
    return { scrolled: to, ...(r?.result?.value ?? {}) };
  }

  const x = Number(params.x ?? 0) || 200;
  const y = Number(params.y ?? 0) || 300;
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  await sleep(150);
  return { scrolled: { dy, dx } };
}

/** Overlay a labelled coordinate grid (set via a marker) so a screenshot shows
 *  pixel coordinates. CSP-safe (DOM + CSSOM only). */
const GRID_JS = `(function(){
  var id='__pilot_grid'; var old=document.getElementById(id); if(old) old.remove();
  var layer=document.createElement('div'); layer.id=id;
  layer.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  var w=window.innerWidth, h=window.innerHeight, step=100;
  function label(x,y,txt){ var s=document.createElement('span'); s.textContent=txt;
    s.style.cssText='position:absolute;left:'+x+'px;top:'+y+'px;font:10px/1 ui-monospace,monospace;color:#e11;background:rgba(255,255,255,.75);padding:0 2px;';
    layer.appendChild(s); }
  for(var x=0;x<=w;x+=step){ var v=document.createElement('div');
    v.style.cssText='position:absolute;top:0;bottom:0;left:'+x+'px;border-left:1px solid rgba(220,20,20,.55);';
    layer.appendChild(v); label(x+2,2,String(x)); }
  for(var y=0;y<=h;y+=step){ var hz=document.createElement('div');
    hz.style.cssText='position:absolute;left:0;right:0;top:'+y+'px;border-top:1px solid rgba(220,20,20,.55);';
    layer.appendChild(hz); label(2,y+2,String(y)); }
  document.documentElement.appendChild(layer);
})()`;

/** CDP screenshot of the tab: viewport by default, the whole scrollable page
 *  with `fullPage`, optionally with a coordinate grid overlay. */
export async function cdpScreenshot(tabId: number, grid = false, fullPage = false): Promise<{ dataUrl: string }> {
  await ensureAttached(tabId);
  if (grid) await send(tabId, 'Runtime.evaluate', { expression: GRID_JS }).catch(() => {});
  let shot: Record<string, unknown> = { format: 'png' };
  if (fullPage) {
    const m = await send(tabId, 'Page.getLayoutMetrics').catch(() => null);
    const size = m?.cssContentSize ?? m?.contentSize;
    if (size) {
      // Chrome refuses absurdly tall captures; 20k px is plenty and still safe.
      const height = Math.min(Math.ceil(size.height), 20_000);
      shot = {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 },
      };
    }
  }
  const r = await send(tabId, 'Page.captureScreenshot', shot, 30_000).catch(() => null);
  if (grid) await send(tabId, 'Runtime.evaluate', { expression: 'var e=document.getElementById("__pilot_grid"); if(e) e.remove();' }).catch(() => {});
  if (!r?.data) throw new Error('screenshot failed');
  return { dataUrl: `data:image/png;base64,${r.data}` };
}

export async function cdpGetText(tabId: number, selector?: string): Promise<unknown> {
  await ensureAttached(tabId);
  if (selector) {
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e?(e.innerText||e.textContent||''):null;})()`,
      returnByValue: true,
    });
    const v = r?.result?.value;
    if (v == null) throw new Error(`getText: no element matches ${selector}`);
    return { selector, text: String(v).slice(0, 20_000) };
  }
  const read = async (contextId?: number) => {
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
      ...(contextId != null ? { contextId } : {}),
    }).catch(() => null);
    return String(r?.result?.value ?? '');
  };
  let text = await read();
  // Include iframe content (e.g. Google consoles render inside frames).
  for (const frameId of await frameIds(tabId)) {
    const w = await send(tabId, 'Page.createIsolatedWorld', {
      frameId, worldName: 'pilot_read', grantUniveralAccess: true,
    }).catch(() => null);
    if (w?.executionContextId != null) text += '\n' + (await read(w.executionContextId));
  }
  return { text: text.slice(0, 20_000) };
}

// ── Read the page's own state ──────────────────────────────────────────────

/**
 * Run JavaScript in the page and return its value as JSON.
 *
 * `expression` is an EXPRESSION or an arrow function — `document.title`,
 * `() => getComputedStyle(document.body).background`, `async () => (await
 * fetch('/api/x')).status`. A function is called; a promise is awaited. The
 * result is JSON-cloned in-page, so DOM nodes come back as their string form
 * rather than failing the whole call.
 */
export async function cdpEvaluate(
  tabId: number,
  expression: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  await ensureAttached(tabId);
  const wrapped = `(async()=>{const __v=(${expression});const __r=await(typeof __v==="function"?__v():__v);` +
    `try{return JSON.parse(JSON.stringify(__r===undefined?null:__r));}catch(e){return String(__r);}})()`;
  const r = await send(tabId, 'Runtime.evaluate', {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  const d = r?.exceptionDetails;
  if (d) throw new Error(String(d.exception?.description ?? d.text ?? 'evaluate failed'));
  const value = r?.result?.value ?? null;
  const json = JSON.stringify(value);
  if (json && json.length > 20_000) {
    return { truncated: true, note: 'result over 20k chars — narrow the expression', value: json.slice(0, 20_000) };
  }
  return { value };
}

/** Poll until `text` appears (or, with `gone`, disappears) / `selector` matches.
 *  Beats sleeping or re-screenshotting to wait out a stream or a load. */
export async function cdpWaitFor(
  tabId: number,
  opts: { text?: string; gone?: string; selector?: string; timeoutMs?: number },
): Promise<unknown> {
  await ensureAttached(tabId);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 10_000, 500), 120_000);
  const started = Date.now();
  const probe = opts.selector
    ? `!!document.querySelector(${JSON.stringify(opts.selector)})`
    : opts.gone
      ? `!(document.body?document.body.innerText:"").includes(${JSON.stringify(opts.gone)})`
      : `(document.body?document.body.innerText:"").includes(${JSON.stringify(opts.text ?? '')})`;
  if (!opts.selector && !opts.gone && !opts.text) throw new Error('waitFor: pass text, gone or selector');
  while (Date.now() - started < timeoutMs) {
    const r = await send(tabId, 'Runtime.evaluate', { expression: probe, returnByValue: true }).catch(() => null);
    if (r?.result?.value === true) return { ok: true, waitedMs: Date.now() - started };
    await sleep(250);
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms (${opts.selector ?? opts.gone ?? opts.text})`);
}

/** Resize the viewport (device emulation) to test responsive layouts.
 *  `width: 0` clears the override and restores the real window size. */
export async function cdpResize(
  tabId: number,
  width: number,
  height: number,
  mobile = false,
): Promise<unknown> {
  await ensureAttached(tabId);
  if (!width || !height) {
    await send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    return { cleared: true };
  }
  await send(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: Math.round(width), height: Math.round(height),
    deviceScaleFactor: 0, mobile,
  });
  await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 }).catch(() => {});
  await sleep(250); // let the page reflow / re-render before the next read
  return { width: Math.round(width), height: Math.round(height), mobile };
}

/** Console messages recorded since Pilot attached to this tab. */
export async function cdpConsole(
  tabId: number,
  opts: { level?: string; limit?: number; clear?: boolean } = {},
): Promise<unknown> {
  await ensureAttached(tabId);
  const all = consoleLog.get(tabId) ?? [];
  const wanted = opts.level && opts.level !== 'all' ? String(opts.level).toLowerCase() : '';
  // "error" should also surface console.assert/exception levels Chrome names differently.
  const match = (e: ConsoleEntry) =>
    !wanted || e.level.toLowerCase() === wanted || (wanted === 'error' && /error|assert|severe/i.test(e.level));
  const hits = all.filter(match);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, LOG_CAP));
  const out = hits.slice(-limit);
  if (opts.clear) consoleLog.set(tabId, []);
  return {
    total: all.length,
    matched: hits.length,
    returned: out.length,
    note: all.length ? undefined : 'Nothing recorded yet — messages are captured only while Pilot is attached, so reload the page to catch load-time errors.',
    messages: out,
  };
}

/** Network requests recorded since Pilot attached to this tab. */
export async function cdpNetwork(
  tabId: number,
  opts: { filter?: string; status?: number; failedOnly?: boolean; limit?: number; clear?: boolean } = {},
): Promise<unknown> {
  await ensureAttached(tabId);
  const all = netLog.get(tabId) ?? [];
  const needle = opts.filter?.toLowerCase();
  const hits = all.filter((e) => {
    if (needle && !e.url.toLowerCase().includes(needle)) return false;
    if (opts.status && e.status !== Number(opts.status)) return false;
    if (opts.failedOnly && !(e.error || (e.status ?? 0) >= 400)) return false;
    return true;
  });
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, LOG_CAP));
  const out = hits.slice(-limit);
  if (opts.clear) { netLog.set(tabId, []); netPending.delete(tabId); }
  return {
    total: all.length,
    matched: hits.length,
    returned: out.length,
    note: all.length ? undefined : 'Nothing recorded yet — requests are captured only while Pilot is attached, so reload or navigate to capture them.',
    requests: out,
  };
}
