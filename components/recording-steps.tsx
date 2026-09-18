import { useEffect, useState } from 'react';
import type { RecordedStep } from '../entrypoints/background';

/** Human title for a recorded step. */
function stepTitle(s: RecordedStep): string {
  switch (s.type) {
    case 'click': return `Click "${s.label}"`;
    case 'input': return `Type "${s.value ?? ''}" into "${s.label}"`;
    case 'change': return `Set "${s.label}" to "${s.value ?? ''}"`;
    case 'submit': return `Submit "${s.label}"`;
    case 'navigate': return `Go to ${s.label || s.url}`;
    default: return s.label;
  }
}

/**
 * A cropped thumbnail of the screenshot, zoomed to the element the user acted
 * on, with a ring over the click point.
 */
function StepThumb({ step }: { step: RecordedStep }) {
  const W = 168, H = 74, PAD = 28;
  if (!step.screenshot || !step.rect || !step.viewport) return null;
  const { x, y, width, height } = step.rect;
  const cropX = Math.max(0, x - PAD);
  const cropY = Math.max(0, y - PAD);
  const cropW = Math.max(1, width + PAD * 2);
  const cropH = Math.max(1, height + PAD * 2);
  const scale = Math.min(W / cropW, H / cropH);
  const tw = cropW * scale;
  const th = cropH * scale;
  const offX = (W - tw) / 2;
  const offY = (H - th) / 2;
  const cx = offX + (x + width / 2 - cropX) * scale;
  const cy = offY + (y + height / 2 - cropY) * scale;
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border"
      style={{
        width: W,
        height: H,
        backgroundImage: `url("${step.screenshot}")`,
        backgroundSize: `${step.viewport.w * scale}px ${step.viewport.h * scale}px`,
        backgroundPosition: `${offX - cropX * scale}px ${offY - cropY * scale}px`,
        backgroundRepeat: 'no-repeat',
      }}
    >
      <span
        className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-blue-500 bg-blue-500/10"
        style={{ left: cx, top: cy }}
      />
    </div>
  );
}

/**
 * Live list of steps captured by the recorder, each with a cropped screenshot
 * of where the user acted. Spoken narration appears inline as quoted text.
 */
export function RecordingSteps() {
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  useEffect(() => {
    const onMsg = (m: any) => { if (m?.type === 'STATE') setSteps(m.steps ?? []); };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.runtime
      .sendMessage({ type: 'GET_STATE' })
      .then((r: any) => { if (r) setSteps(r.steps ?? []); })
      .catch(() => {});
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  if (!steps.length) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
      {steps.map((s, i) =>
        s.type === 'note' ? (
          <p key={s.id} className="text-muted-foreground ps-6 text-xs italic">
            “{s.label}”
          </p>
        ) : (
          <div key={s.id} className="flex items-center gap-3">
            <span className="text-muted-foreground w-4 shrink-0 text-right text-xs tabular-nums">
              {i + 1}
            </span>
            <StepThumb step={s} />
            <span className="min-w-0 flex-1 text-xs">{stepTitle(s)}</span>
          </div>
        ),
      )}
      {steps.length === 0 && (
        <p className="text-muted-foreground px-1 py-6 text-center text-xs">
          Act on the page — steps with a screenshot of where you clicked will appear here.
        </p>
      )}
    </div>
  );
}
