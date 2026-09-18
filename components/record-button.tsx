import { useEffect, useState } from 'react';
import { TooltipIconButton } from './tooltip-icon-button';
import { cn } from '../lib/utils';

/**
 * Self-contained Record toggle that lives in the chat composer. It mirrors the
 * recorder state from the background (STATE messages) and starts/stops recording.
 * The record → skill hand-off is handled in App (it watches for the stop and
 * appends the captured steps to the thread).
 */
export function RecordButton() {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    const onMsg = (m: any) => { if (m?.type === 'STATE') setRecording(!!m.isRecording); };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((r: any) => { if (r) setRecording(!!r.isRecording); }).catch(() => {});
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  return (
    <TooltipIconButton
      tooltip={recording ? 'Stop recording & make a skill' : 'Record your actions as a skill'}
      side="bottom"
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-7 rounded-full', recording ? 'text-red-500' : 'text-muted-foreground hover:text-foreground')}
      aria-label={recording ? 'Stop recording' : 'Record'}
      onClick={() => chrome.runtime.sendMessage({ type: recording ? 'STOP' : 'START' }).catch(() => {})}
    >
      <span
        className={cn(
          'inline-block size-3 bg-current',
          recording ? 'rounded-[2px]' : 'rounded-full',
        )}
      />
    </TooltipIconButton>
  );
}
