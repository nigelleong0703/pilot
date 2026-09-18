import { defineContentScript } from 'wxt/sandbox';
import type { RecordedStep } from './background';
import type { PageCommand, SnapshotNode } from '../lib/protocol';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    // Guard against double-initialization: the script is both declared in the
    // manifest AND injected on-demand by the background worker (to recover from
    // SPA reloads). Without this, listeners would register twice.
    const w = window as unknown as { __mcpRecorderLoaded?: boolean };
    if (w.__mcpRecorderLoaded) return;
    w.__mcpRecorderLoaded = true;

    /** Send one captured step to the background service worker. */
    function emit(step: Omit<RecordedStep, 'id'>) {
      chrome.runtime
        .sendMessage({ type: 'USER_EVENT', payload: step })
        .catch(() => {
          // Service worker asleep or extension reloaded — safe to ignore.
        });
    }

    /** Human-readable name for an element, in priority order. */
    function semanticLabel(el: Element): string {
      const e = el as HTMLElement;

      const aria = e.getAttribute('aria-label');
      if (aria?.trim()) return aria.trim();

      const id = e.getAttribute('id');
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent?.trim()) return lbl.textContent.trim();
      }
      const wrapping = e.closest('label');
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

      const ph = e.getAttribute('placeholder') || e.getAttribute('title');
      if (ph?.trim()) return ph.trim();

      const text = e.textContent?.trim();
      if (text && text.length <= 80) return text;

      const val = (e as HTMLInputElement).value;
      if (val?.trim() && val.length <= 80) return val.trim();

      const name = e.getAttribute('name');
      if (name) return name;

      return e.tagName.toLowerCase();
    }

    /** Best-effort, reasonably stable CSS selector. */
    function cssSelector(el: Element): string {
      const e = el as HTMLElement;
      if (e.id) return `#${CSS.escape(e.id)}`;

      const dataTestId = e.getAttribute('data-testid') || e.getAttribute('data-test');
      if (dataTestId) return `[data-testid="${CSS.escape(dataTestId)}"]`;

      const name = e.getAttribute('name');
      if (name) return `${e.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;

      const parts: string[] = [];
      let node: Element | null = e;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 4) {
        const current: Element = node;
        let part = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            (c) => c.tagName === current.tagName,
          );
          if (sameTag.length > 1) {
            part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
          }
        }
        parts.unshift(part);
        node = parent;
        depth++;
      }
      return parts.join(' > ');
    }

    function baseStep(el: Element): Pick<RecordedStep, 'label' | 'selector' | 'url' | 'ts'> {
      return {
        label: semanticLabel(el),
        selector: cssSelector(el),
        url: location.href,
        ts: Date.now(),
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Recording: capture user actions
    // ─────────────────────────────────────────────────────────────────────
    document.addEventListener(
      'click',
      (ev) => {
        const target = ev.target as Element | null;
        if (!target) return;
        const el = target.closest('button, a, input, [role="button"], summary') || target;
        emit({ type: 'click', ...baseStep(el) });
      },
      true,
    );

    document.addEventListener(
      'change',
      (ev) => {
        const el = ev.target as HTMLInputElement | HTMLSelectElement | null;
        if (!el) return;

        if (el.tagName === 'SELECT') {
          const sel = el as HTMLSelectElement;
          const optText = sel.options[sel.selectedIndex]?.text ?? sel.value;
          emit({ type: 'change', value: optText, ...baseStep(el) });
          return;
        }

        const input = el as HTMLInputElement;
        if (input.type === 'checkbox' || input.type === 'radio') {
          emit({ type: 'change', value: String(input.checked), ...baseStep(el) });
          return;
        }

        emit({ type: 'input', value: input.value, ...baseStep(el) });
      },
      true,
    );

    document.addEventListener(
      'submit',
      (ev) => {
        const form = ev.target as HTMLFormElement | null;
        if (!form) return;
        const submitter =
          (ev as SubmitEvent).submitter ??
          form.querySelector('[type="submit"], button') ??
          form;
        emit({ type: 'submit', ...baseStep(submitter) });
      },
      true,
    );

    // ─────────────────────────────────────────────────────────────────────
    // Remote control: commands forwarded from the MCP bridge via background
    // ─────────────────────────────────────────────────────────────────────
    const isInteractive = (el: Element): boolean => {
      const tag = el.tagName.toLowerCase();
      if (['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
      const role = el.getAttribute('role');
      if (role && ['button', 'link', 'checkbox', 'tab', 'menuitem'].includes(role)) return true;
      return el.hasAttribute('onclick');
    };

    function buildSnapshot(): SnapshotNode[] {
      // Perf: getComputedStyle per element freezes heavy pages. Two cheap passes:
      // (1) filter interactive by tag/role only (no layout), capped; then
      // (2) read getBoundingClientRect (no getComputedStyle) for visibility.
      const all = document.querySelectorAll<HTMLElement>(
        'a, button, input, select, textarea, summary, [role], [onclick]',
      );
      const SCAN_CAP = 4000;
      const candidates: HTMLElement[] = [];
      const limit = Math.min(all.length, SCAN_CAP);
      for (let i = 0; i < limit; i++) {
        const el = all[i]!;
        if (isInteractive(el)) candidates.push(el);
        if (candidates.length >= 900) break;
      }

      const nodes: SnapshotNode[] = [];
      let ref = 1;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // hidden / not rendered
        el.setAttribute('data-mcp-ref', String(ref));
        nodes.push({
          ref,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          label: semanticLabel(el),
          value: (el as HTMLInputElement).value || undefined,
          tag: el.tagName.toLowerCase(),
        });
        ref++;
        if (ref > 300) break; // safety cap
      }
      return nodes;
    }

    function resolve(params: Record<string, unknown>): HTMLElement | null {
      if (typeof params.ref === 'number') {
        return document.querySelector<HTMLElement>(`[data-mcp-ref="${params.ref}"]`);
      }
      if (typeof params.selector === 'string') {
        return document.querySelector<HTMLElement>(params.selector);
      }
      return null;
    }

    // ── Visual cues (banner + numbered element tags), à la Claude in Chrome ──
    const OVERLAY_ID = 'mcp-recorder-overlays';
    const BANNER_ID = 'mcp-recorder-banner';

    function showBanner(on: boolean) {
      const existing = document.getElementById(BANNER_ID);
      if (!on) {
        existing?.remove();
        return;
      }
      if (existing) return;
      const b = document.createElement('div');
      b.id = BANNER_ID;
      b.textContent = '⏺ Browser Extension — recording this tab';
      Object.assign(b.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: '2147483647',
        background: '#dc2626',
        color: '#fff',
        font: '600 12px system-ui, sans-serif',
        textAlign: 'center',
        padding: '4px 8px',
        pointerEvents: 'none',
        boxShadow: '0 1px 6px rgba(0,0,0,.3)',
      } as CSSStyleDeclaration);
      document.documentElement.appendChild(b);
    }

    // Recording-banner state. Tab-strip indication is handled natively in the
    // background via tab groups (see groupTab) — no title hacks here.
    let tabRecording = false;

    function clearOverlays() {
      document.getElementById(OVERLAY_ID)?.remove();
    }

    function drawOverlays(nodes: SnapshotNode[]) {
      clearOverlays();
      const layer = document.createElement('div');
      layer.id = OVERLAY_ID;
      Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483646',
        pointerEvents: 'none',
      } as CSSStyleDeclaration);

      for (const n of nodes.slice(0, 150)) {
        const el = document.querySelector<HTMLElement>(`[data-mcp-ref="${n.ref}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;

        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'fixed',
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          border: '1px solid rgba(37,99,235,.9)',
          background: 'rgba(37,99,235,.08)',
          borderRadius: '2px',
          pointerEvents: 'none',
        } as CSSStyleDeclaration);

        const tag = document.createElement('div');
        tag.textContent = String(n.ref);
        Object.assign(tag.style, {
          position: 'fixed',
          left: `${r.left}px`,
          top: `${Math.max(0, r.top - 14)}px`,
          background: '#2563eb',
          color: '#fff',
          font: '600 10px/1.3 ui-monospace, monospace',
          padding: '0 4px',
          borderRadius: '3px',
          pointerEvents: 'none',
        } as CSSStyleDeclaration);

        layer.append(box, tag);
      }
      document.documentElement.appendChild(layer);
      // Tags are viewport-anchored; clear them on scroll so they don't drift.
      window.addEventListener('scroll', clearOverlays, { once: true, passive: true });
      setTimeout(clearOverlays, 6000);
    }

    /** Briefly flash an element when we act on it (acting feedback). */
    function flash(el: HTMLElement) {
      const prev = el.style.outline;
      el.style.outline = '2px solid #16a34a';
      setTimeout(() => (el.style.outline = prev), 600);
    }

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function handleCommand(cmd: PageCommand): Promise<unknown> {
      const params = cmd.params ?? {};
      switch (cmd.method) {
        case 'snapshot': {
          // SPAs (e.g. Odoo/OWL) reach load-complete with an empty shell, then
          // render via JS. Poll briefly until interactive elements appear.
          let nodes = buildSnapshot();
          for (let i = 0; i < 16 && nodes.length === 0; i++) {
            await delay(250);
            nodes = buildSnapshot();
          }
          drawOverlays(nodes);
          return { url: location.href, title: document.title, nodes };
        }

        case 'getText': {
          let text = document.body?.innerText ?? '';
          for (let i = 0; i < 16 && text.trim().length === 0; i++) {
            await delay(250);
            text = document.body?.innerText ?? '';
          }
          return { url: location.href, text: text.slice(0, 20_000) };
        }

        case 'click': {
          const el = resolve(params);
          if (!el) throw new Error('Element not found for click');
          clearOverlays();
          el.scrollIntoView({ block: 'center' });
          flash(el);
          el.click();
          return { clicked: semanticLabel(el) };
        }

        case 'type': {
          const el = resolve(params) as HTMLInputElement | null;
          if (!el) throw new Error('Element not found for type');
          clearOverlays();
          flash(el);
          el.focus();
          const text = String(params.text ?? '');
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (params.submit) {
            if (el.form?.requestSubmit) {
              el.form.requestSubmit();
            } else {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }
          }
          return { typed: text, into: semanticLabel(el) };
        }

        case 'selectOption': {
          const el = resolve(params) as HTMLSelectElement | null;
          if (!el) throw new Error('Element not found for selectOption');
          if (el.tagName !== 'SELECT') throw new Error('Element is not a <select>');
          const optionText = String(params.text ?? '');
          // Match by display text (case-insensitive trim)
          const option = Array.from(el.options).find(
            (o) => o.text.trim().toLowerCase() === optionText.trim().toLowerCase(),
          );
          if (!option) {
            const available = Array.from(el.options).map((o) => o.text.trim());
            throw new Error(`Option "${optionText}" not found. Available: ${available.join(', ')}`);
          }
          clearOverlays();
          flash(el);
          el.focus();
          el.value = option.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: option.text.trim(), value: option.value, into: semanticLabel(el) };
        }
      }
    }

    // Record navigations (full page loads + SPA route changes) as steps, so a
    // recording captures URL transitions — not just clicks. Only the visible
    // tab emits, so background tabs don't spam the recording.
    let lastNavUrl: string | null = null;
    function emitNavigate() {
      if (!tabRecording) return;
      if (document.visibilityState !== 'visible') return;
      if (location.href === lastNavUrl) return;
      lastNavUrl = location.href;
      emit({
        type: 'navigate',
        label: (document.title || location.href).trim(),
        selector: '',
        url: location.href,
        ts: Date.now(),
      });
    }
    window.addEventListener('popstate', emitNavigate);
    setInterval(emitNavigate, 700); // catches pushState/replaceState SPA routes

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.kind === 'RECORDING_STATE') {
        tabRecording = Boolean(msg.recording);
        showBanner(tabRecording);
        if (tabRecording) {
          lastNavUrl = null; // record the starting page as the first step
          emitNavigate();
        }
        return;
      }
      if (msg?.kind !== 'COMMAND') return;
      handleCommand(msg as PageCommand)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true; // async response
    });

    // On load, learn current recording + control state so the banner and tab
    // marker are correct (e.g. after a navigation mid-session).
    chrome.runtime
      .sendMessage({ type: 'PAGE_HELLO' })
      .then((res) => {
        tabRecording = Boolean(res?.recording);
        showBanner(tabRecording);
        emitNavigate(); // if we loaded into an in-progress recording, log the URL
      })
      .catch(() => {});
  },
});
