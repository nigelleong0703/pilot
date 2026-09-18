/**
 * On-page agent-action visual: a cursor that glides to the element and clicks,
 * with a glowing halo around the target.
 *
 * This function is intentionally self-contained (no imports, no closures) so the
 * CDP path can serialize it with `Function.prototype.toString()` and run it in
 * the page via `Runtime.evaluate`. It avoids `<style>`/keyframes and innerHTML
 * so it keeps working under strict Content-Security-Policy and Trusted Types
 * (e.g. Google properties) — using DOM APIs and the Web Animations API instead.
 */
export interface OverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function paintAgentCursor(
  box: OverlayBox,
  action: 'click' | 'type' | 'select',
): void {
  try {
    const LAYER = '__pilot_overlay';
    let layer = document.getElementById(LAYER);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = LAYER;
      layer.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      document.documentElement.appendChild(layer);

      const cursor = document.createElement('div');
      cursor.id = '__pilot_cursor';
      cursor.style.cssText =
        'position:fixed;left:0;top:0;width:22px;height:22px;opacity:0;' +
        'transform:translate(-100px,-100px);z-index:2147483647;pointer-events:none;' +
        'filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));';
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '22');
      svg.setAttribute('height', '22');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M5 3 L5 20 L9.6 15.2 L12.7 21.6 L15.3 20.4 L12.3 14.2 L18.4 14.2 Z');
      path.setAttribute('fill', '#7c5cff');
      path.setAttribute('stroke', '#ffffff');
      path.setAttribute('stroke-width', '1.2');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      cursor.appendChild(svg);
      document.documentElement.appendChild(cursor);
    }

    const rgb =
      action === 'type' ? '22,163,74' : action === 'select' ? '217,119,6' : '37,99,235';
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const cursor = document.getElementById('__pilot_cursor');
    if (cursor) {
      cursor.style.transition =
        'transform .5s cubic-bezier(.2,.8,.2,1), opacity .25s';
      cursor.style.opacity = '1';
      cursor.style.transform = 'translate(' + (cx - 2) + 'px,' + (cy - 2) + 'px)';
    }

    const glow = document.createElement('div');
    glow.style.cssText =
      'position:fixed;left:' + (box.x - 6) + 'px;top:' + (box.y - 6) + 'px;' +
      'width:' + (box.width + 12) + 'px;height:' + (box.height + 12) + 'px;' +
      'border-radius:8px;pointer-events:none;background:rgba(' + rgb + ',.10);' +
      'box-shadow:0 0 0 2px rgba(' + rgb + ',.95),0 0 26px 8px rgba(' + rgb + ',.55);';
    document.documentElement.appendChild(glow);
    try {
      glow.animate(
        [{ opacity: 0.55 }, { opacity: 1 }, { opacity: 0.55 }],
        { duration: 900, iterations: 2 },
      );
    } catch { /* Web Animations unavailable */ }

    if (action === 'click') {
      const rip = document.createElement('div');
      rip.style.cssText =
        'position:fixed;left:' + cx + 'px;top:' + cy + 'px;width:30px;height:30px;' +
        'margin:-15px 0 0 -15px;border-radius:50%;background:rgba(' + rgb + ',.45);' +
        'pointer-events:none;';
      document.documentElement.appendChild(rip);
      try {
        rip.animate(
          [{ transform: 'scale(.25)', opacity: 0.75 }, { transform: 'scale(1.7)', opacity: 0 }],
          { duration: 550, easing: 'ease-out', fill: 'forwards' },
        );
      } catch { /* ignore */ }
      setTimeout(function () { rip.remove(); }, 700);
    }

    setTimeout(function () {
      try {
        glow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' });
      } catch { /* ignore */ }
      setTimeout(function () { glow.remove(); }, 420);
    }, 1200);

    const w = window as unknown as { __pilot_cursor_t?: ReturnType<typeof setTimeout> };
    if (w.__pilot_cursor_t) clearTimeout(w.__pilot_cursor_t);
    w.__pilot_cursor_t = setTimeout(function () {
      if (cursor) cursor.style.opacity = '0';
    }, 2000);
  } catch { /* never break the page */ }
}

/**
 * Full-viewport glow frame shown while the agent is controlling the page (à la
 * Claude in Chrome / Comet): the whole page gets a pulsing colored border. Call
 * repeatedly during a run to keep it alive; it fades out `ms` after the last
 * call. CSP-safe (WAAPI + CSSOM only).
 */
export function paintAgentFrame(ms: number): void {
  try {
    let frame = document.getElementById('__pilot_frame');
    if (!frame) {
      frame = document.createElement('div');
      frame.id = '__pilot_frame';
      frame.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483644;' +
        'border-radius:6px;opacity:0;transition:opacity .3s;';
      document.documentElement.appendChild(frame);
      const f = frame as unknown as { __anim?: Animation };
      try {
        f.__anim = frame.animate(
          [
            { boxShadow: 'inset 0 0 0 3px rgba(37,99,235,.85), inset 0 0 34px 8px rgba(37,99,235,.28)' },
            { boxShadow: 'inset 0 0 0 4px rgba(37,99,235,1), inset 0 0 62px 18px rgba(37,99,235,.5)' },
          ],
          { duration: 1400, iterations: Infinity, direction: 'alternate' },
        );
      } catch { /* Web Animations unavailable */ }
    }
    frame.style.opacity = '1';
    const w = window as unknown as { __pilot_frame_t?: ReturnType<typeof setTimeout> };
    if (w.__pilot_frame_t) clearTimeout(w.__pilot_frame_t);
    w.__pilot_frame_t = setTimeout(function () {
      const el = document.getElementById('__pilot_frame');
      if (el) el.style.opacity = '0';
    }, ms);
  } catch { /* ignore */ }
}

export function clearAgentFrame(): void {
  try {
    const w = window as unknown as { __pilot_frame_t?: ReturnType<typeof setTimeout> };
    if (w.__pilot_frame_t) clearTimeout(w.__pilot_frame_t);
    document.getElementById('__pilot_frame')?.remove();
  } catch { /* ignore */ }
}
