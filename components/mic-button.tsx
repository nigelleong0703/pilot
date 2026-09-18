import { useEffect, useRef, useState } from 'react';
import { MicIcon } from 'lucide-react';
import { TooltipIconButton } from './tooltip-icon-button';
import { cn } from '../lib/utils';

/**
 * Dictate narration while recording. Speech is transcribed by the browser's
 * Web Speech API; each final phrase is sent to the background as a NOTE, which
 * is recorded as a step interleaved with the user's actions — so the narration
 * flows into the skill the agent authors. Audio is never stored.
 *
 * Chrome suppresses the microphone prompt inside a side panel, so the first
 * use opens `micauth.html` (a visible extension page) to grant access; the
 * `MIC_GRANTED` message then starts recognition here.
 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
}

export function MicButton() {
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState(false); // waiting for permission in the helper tab
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRef = useRef(false); // user intent, survives onend auto-restarts
  const recordingRef = useRef(false);
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Broadcast dictation state so the recording banner can show a live indicator.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('pilot:dictation', { detail: { listening, pending } }));
  }, [listening, pending]);

  useEffect(() => {
    const onMsg = (m: any) => {
      if (m?.type === 'STATE') {
        recordingRef.current = !!m.isRecording;
        if (!m.isRecording && wantRef.current) stop();
      } else if (m?.type === 'MIC_GRANTED') {
        if (wantRef.current) begin();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.runtime
      .sendMessage({ type: 'GET_STATE' })
      .then((r: any) => { if (r) recordingRef.current = !!r.isRecording; })
      .catch(() => {});
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function make(): SpeechRecognitionLike | null {
    const Ctor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return null;
    const r: SpeechRecognitionLike = new Ctor();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res.isFinal) continue;
        const text = String(res[0]?.transcript ?? '').trim();
        if (text) chrome.runtime.sendMessage({ type: 'NOTE', text }).catch(() => {});
      }
    };
    r.onerror = (e: any) => {
      const code = String(e?.error ?? '');
      // Permission wasn't actually granted → send the user to the helper page.
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setListening(false);
        if (wantRef.current) openAuthPage();
        return;
      }
      if (code === 'audio-capture') {
        setListening(false);
        alert('No microphone was found. Connect one and click the mic again.');
      } else if (code === 'network') {
        setListening(false);
        alert('Speech recognition needs an internet connection.');
      }
      // `no-speech` / `aborted` are normal — onend will restart.
    };
    r.onend = () => {
      // Chrome ends recognition on silence. Restart AFTER a short delay —
      // calling start() synchronously here throws InvalidStateError, which used
      // to kill dictation after the first pause.
      if (!wantRef.current) { setListening(false); return; }
      if (restartRef.current) clearTimeout(restartRef.current);
      restartRef.current = setTimeout(() => {
        if (!wantRef.current) return;
        try { r.start(); setListening(true); } catch { /* retry on next end */ }
      }, 300);
    };
    return r;
  }

  function openAuthPage() {
    setPending(true);
    chrome.tabs.create({ url: chrome.runtime.getURL('micauth.html') }).catch(() => {});
  }

  function begin() {
    const r = recRef.current ?? (recRef.current = make());
    if (!r) { alert('Speech recognition is not available in this browser.'); return; }
    wantRef.current = true;
    setPending(false);
    try { r.start(); setListening(true); } catch { /* already started */ }
  }

  async function hasPermission(): Promise<boolean> {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return st.state === 'granted';
    } catch {
      return false; // unknown → route through the helper page once
    }
  }

  async function start() {
    if (wantRef.current) return;
    wantRef.current = true;
    setPending(true);
    // NOTE steps are dropped unless recording is on — start it if needed.
    if (!recordingRef.current) {
      chrome.runtime.sendMessage({ type: 'START' }).catch(() => {});
      recordingRef.current = true;
    }
    if (await hasPermission()) begin();
    else openAuthPage(); // Chrome needs a visible page to grant the mic
  }

  function stop() {
    wantRef.current = false;
    setListening(false);
    setPending(false);
    if (restartRef.current) { clearTimeout(restartRef.current); restartRef.current = null; }
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }

  const active = listening || pending;

  return (
    <TooltipIconButton
      tooltip={
        listening ? 'Listening… click to stop dictation'
          : pending ? 'Waiting for microphone permission…'
            : 'Dictate narration (voice → text)'
      }
      side="bottom"
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        'size-7 rounded-full',
        active ? 'text-red-500' : 'text-muted-foreground hover:text-foreground',
      )}
      aria-label={listening ? 'Stop dictation' : 'Start dictation'}
      onClick={() => (wantRef.current ? stop() : void start())}
    >
      <MicIcon className={cn('size-4', active && 'animate-pulse')} />
    </TooltipIconButton>
  );
}
