import { useEffect, useRef, useState } from 'react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { SettingsIcon, ArrowLeftIcon, SquarePenIcon } from 'lucide-react';
import { TooltipProvider } from '../../components/ui/tooltip';
import { Thread } from '../../components/thread';
import { cn } from '../../lib/utils';
import { acpAdapter, resetSession } from './adapter';
import { post, request, type RecordedStep } from './bridge';
import { AGENTS, CLAUDE_MODELS, loadSettings, saveSettings, type AgentId, type Settings } from './settings';

export default function App() {
  const [bridge, setBridge] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<{ title: string; url: string }>({ title: '', url: '' });
  const [recording, setRecording] = useState(false);
  const [stepCount, setStepCount] = useState(0);
  const [threadKey, setThreadKey] = useState(0);

  useEffect(() => {
    const onMsg = (msg: any) => {
      if (msg?.type === 'STATE') {
        setBridge(!!msg.bridgeConnected);
        setRecording(!!msg.isRecording);
        setStepCount((msg.steps ?? []).length);
      } else if (msg?.type === 'ACTIVE_TAB') {
        setTab({ title: msg.title ?? '', url: msg.url ?? '' });
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    request({ type: 'GET_STATE' }).then((r: any) => {
      if (!r) return;
      setBridge(!!r.bridgeConnected);
      setRecording(!!r.isRecording);
      setStepCount((r.steps ?? []).length);
    });
    request({ type: 'GET_PAGE_CONTEXT' }).then((r: any) => { if (r) setTab({ title: r.title ?? '', url: r.url ?? '' }); });
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  function newChat() {
    resetSession();
    setThreadKey((k) => k + 1); // remount Chat → fresh empty thread
    setShowSettings(false);
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
        {/* Header */}
        <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-semibold">⏺ Pilot</span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={newChat}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="New chat"
              title="New chat"
            >
              <SquarePenIcon className="size-4" />
            </button>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Settings"
              title="Settings"
            >
              {showSettings ? <ArrowLeftIcon className="size-4" /> : <SettingsIcon className="size-4" />}
            </button>
          </div>
        </header>

        {showSettings ? (
          <SettingsPage bridge={bridge} onBack={() => setShowSettings(false)} />
        ) : (
          <>
            {recording ? (
              <div className="flex shrink-0 items-center gap-2 border-b bg-red-50 px-3 py-1.5 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
                Recording · {stepCount} step{stepCount === 1 ? '' : 's'} — act on the page, then Stop.
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
                <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={tab.url || undefined}>
                  ▸ {tab.title || tab.url || 'no active tab'}
                </span>
              </div>
            )}
            <Chat key={threadKey} />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Chat — owns the runtime (remounted on "New chat") and the record→skill hand-off
// ════════════════════════════════════════════════════════════════════════════
function Chat() {
  const runtime = useLocalRuntime(acpAdapter);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const wasRecording = useRef(false);

  function append(text: string) {
    try {
      (runtimeRef.current as any).thread.append({ role: 'user', content: [{ type: 'text', text }] });
    } catch { /* runtime not ready */ }
  }

  useEffect(() => {
    const onMsg = (msg: any) => {
      if (msg?.type !== 'STATE') return;
      const rec = !!msg.isRecording;
      const steps: RecordedStep[] = msg.steps ?? [];
      if (wasRecording.current && !rec && steps.length > 0) handOff(steps);
      wasRecording.current = rec;
    };
    // Fired by the composer "+" menu to run a skill / attach content in this thread.
    const onRun = (e: Event) => append((e as CustomEvent<string>).detail);
    const onRunParts = (e: Event) => {
      try {
        (runtimeRef.current as any).thread.append({ role: 'user', content: (e as CustomEvent<any[]>).detail });
      } catch { /* runtime not ready */ }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    window.addEventListener('pilot:run', onRun as EventListener);
    window.addEventListener('pilot:runParts', onRunParts as EventListener);
    request({ type: 'GET_STATE' }).then((r: any) => { if (r) wasRecording.current = !!r.isRecording; });
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      window.removeEventListener('pilot:run', onRun as EventListener);
      window.removeEventListener('pilot:runParts', onRunParts as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handOff(steps: RecordedStep[]) {
    const clean = steps.map(({ screenshot, ...rest }) => rest);
    append(
      'I just recorded these actions on the page. Analyze them and call the `save_skill` tool ' +
      'to save a reusable, parameterized skill (short name, one-line description, any inputs that ' +
      'should be variables, and the ordered browser_* steps to replay it). Then confirm what you saved.' +
      '\n\n```json\n' + JSON.stringify(clean, null, 2) + '\n```',
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Settings
// ════════════════════════════════════════════════════════════════════════════
function SettingsPage({ bridge, onBack }: { bridge: boolean; onBack: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { loadSettings().then(setS); }, []);

  const update = (patch: Partial<Settings>) => {
    setS((prev) => (prev ? { ...prev, ...patch } : prev));
    saveSettings(patch);
    if ('agentId' in patch || 'customCmd' in patch || 'customArgs' in patch) resetSession();
  };

  if (!s) return null;
  const active = AGENTS.find((a) => a.id === s.agentId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <h2 className="mb-4 text-sm font-semibold">Settings</h2>

      <section className="mb-6">
        <label className="mb-1 block text-xs font-medium">Agent</label>
        <select
          value={s.agentId}
          onChange={(e) => update({ agentId: e.target.value as AgentId })}
          className="h-9 w-full rounded-md border bg-card px-2 text-sm"
        >
          {AGENTS.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
        </select>
        {active && <p className="mt-1.5 text-xs text-muted-foreground">{active.hint}</p>}

        {s.agentId === 'custom' && (
          <div className="mt-3 space-y-2">
            <input
              value={s.customCmd}
              onChange={(e) => update({ customCmd: e.target.value })}
              placeholder="Command (e.g. npx)"
              className="h-8 w-full rounded-md border bg-card px-2 text-sm"
            />
            <input
              value={s.customArgs}
              onChange={(e) => update({ customArgs: e.target.value })}
              placeholder="Args (e.g. -y some-acp-agent --stdio)"
              className="h-8 w-full rounded-md border bg-card px-2 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Any ACP agent that speaks stdio. To drive the page it must support client MCP servers in <code>session/new</code>.
            </p>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Changing the agent starts a fresh conversation.</p>
      </section>

      {s.agentId === 'claude' && (
        <section className="mb-6">
          <label className="mb-1 block text-xs font-medium">Model</label>
          <select
            value={s.model}
            onChange={(e) => update({ model: e.target.value })}
            className="h-9 w-full rounded-md border bg-card px-2 text-sm"
          >
            {CLAUDE_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
          </select>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={s.thinking} onChange={(e) => update({ thinking: e.target.checked })} />
            Show the agent's thinking (reasoning)
          </label>
        </section>
      )}

      <section className="mb-6">
        <label className="mb-1 block text-xs font-medium">Page control</label>
        <select
          value={s.pageMode}
          onChange={(e) => update({ pageMode: e.target.value as 'dom' | 'cdp' })}
          className="h-9 w-full rounded-md border bg-card px-2 text-sm"
        >
          <option value="cdp">Robust (CDP) — native, shows a debugger banner</option>
          <option value="dom">Fast (DOM) — no banner</option>
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          CDP reads Chrome's accessibility tree and sends real input events (like Claude in Chrome). A
          "Pilot is debugging this browser" banner shows while active.
        </p>
      </section>

      <section className="mb-6">
        <label className="mb-1 block text-xs font-medium">Connection</label>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('inline-block h-2.5 w-2.5 rounded-full', bridge ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          {bridge ? 'Connected to the local agent bridge' : 'Offline — is the daemon running?'}
        </div>
      </section>

      <button onClick={onBack} className="mt-auto self-start rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
        Back to chat
      </button>
    </div>
  );
}
