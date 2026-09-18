import { useEffect, useRef, useState } from 'react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { DropdownMenu } from 'radix-ui';
import {
  SettingsIcon, ArrowLeftIcon, SquarePenIcon, HistoryIcon, MoreHorizontalIcon,
  Trash2Icon, PencilIcon, SparklesIcon,
} from 'lucide-react';
import { TooltipProvider } from '../../components/ui/tooltip';
import { Thread } from '../../components/thread';
import { cn } from '../../lib/utils';
import { acpAdapter, resetSession, resumeSession } from './adapter';
import { request, acp, type RecordedStep } from './bridge';
import { AGENTS, CLAUDE_MODELS, AGENT_CAPS, BYO_ENV_KEY, BYO_BASE_URL_ENV, type AgentId } from './settings';
import { useSettings } from './settings-store';

type View = 'chat' | 'settings' | 'history' | 'skills';

export default function App() {
  const [bridge, setBridge] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [tab, setTab] = useState<{ title: string; url: string }>({ title: '', url: '' });
  const [recording, setRecording] = useState(false);
  const [stepCount, setStepCount] = useState(0);
  const [threadKey, setThreadKey] = useState(0);
  const loadSettings = useSettings((s) => s.load);

  useEffect(() => {
    void loadSettings();
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
  }, [loadSettings]);

  function newChat() {
    resetSession();
    setThreadKey((k) => k + 1); // remount Chat → fresh empty thread
    setView('chat');
  }

  function continueChat(sessionId: string) {
    resumeSession(sessionId);
    setThreadKey((k) => k + 1);
    setView('chat');
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
        {/* Header: history · new chat · ⋮ menu */}
        <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-semibold">⏺ Pilot</span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setView('history')}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Chat history"
              title="Chat history"
            >
              <HistoryIcon className="size-4" />
            </button>
            <button
              onClick={newChat}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="New chat"
              title="New chat"
            >
              <SquarePenIcon className="size-4" />
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Menu"
                  title="Menu"
                >
                  <MoreHorizontalIcon className="size-4" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-50 min-w-40 rounded-md border bg-card p-1 text-card-foreground shadow-md"
                >
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                    onSelect={() => setView('skills')}
                  >
                    <SparklesIcon className="size-4" /> Skills
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                    onSelect={() => setView('settings')}
                  >
                    <SettingsIcon className="size-4" /> Settings
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        {view === 'settings' ? (
          <SettingsPage bridge={bridge} onBack={() => setView('chat')} />
        ) : view === 'history' ? (
          <HistoryPage onBack={() => setView('chat')} onContinue={continueChat} />
        ) : view === 'skills' ? (
          <SkillsPage onBack={() => setView('chat')} />
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
// History — past chats from the daemon, with transcript view + continue
// ════════════════════════════════════════════════════════════════════════════
interface SessionSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}
interface ChatMsg { role: string; text: string; ts: number; }

function HistoryPage({ onBack, onContinue }: { onBack: () => void; onContinue: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [open, setOpen] = useState<{ id: string; messages: ChatMsg[] } | null>(null);

  useEffect(() => {
    const onMsg = (m: any) => {
      if (m?.kind !== 'ACP_UPDATE') return;
      const p = m.payload;
      if (p?.type === 'acp/sessions') setSessions(p.sessions ?? []);
      else if (p?.type === 'acp/history') setOpen({ id: p.sessionId, messages: p.messages ?? [] });
    };
    chrome.runtime.onMessage.addListener(onMsg);
    acp({ type: 'acp/listSessions' });
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const fmt = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">History</h2>
        <button onClick={onBack} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
          <ArrowLeftIcon className="size-3.5" /> Back
        </button>
      </div>

      {open ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <button
            onClick={() => onContinue(open.id)}
            className="mb-3 self-start rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Continue this chat →
          </button>
          <div className="flex flex-col gap-3">
            {open.messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm',
                  m.role === 'user' ? 'ml-auto bg-primary/10' : m.role === 'tool' ? 'bg-muted/50 font-mono text-xs' : 'bg-muted',
                )}
              >
                {m.role !== 'user' && m.role !== 'assistant' && (
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{m.role}</div>
                )}
                <pre className="wrap-break-word whitespace-pre-wrap font-inherit">{m.text}</pre>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">No past chats yet.</p>
          )}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => acp({ type: 'acp/loadSession', sessionId: s.sessionId })}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{s.title}</span>
                <span className="block text-[11px] text-muted-foreground">{s.messageCount} msgs</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{fmt(s.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Skills — manage saved skills (rename / delete), see what's saved
// ════════════════════════════════════════════════════════════════════════════
interface Skill { id: string; name: string; description?: string; inputs?: string[]; steps?: string[] }

function SkillsPage({ onBack }: { onBack: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    const onMsg = (m: any) => {
      if (m?.kind === 'ACP_UPDATE' && m.payload?.type === 'acp/skills') {
        setSkills(m.payload.skills ?? []);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    acp({ type: 'acp/listSkills' });
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  function startRename(s: Skill) {
    setEditing(s.id);
    setName(s.name);
  }
  function commitRename() {
    if (editing && name.trim()) acp({ type: 'acp/renameSkill', id: editing, name: name.trim() });
    setEditing(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Skills</h2>
        <button onClick={onBack} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
          <ArrowLeftIcon className="size-3.5" /> Back
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {skills.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No skills yet — record actions and press "Make skill" to create one.
          </p>
        )}
        {skills.map((s) => (
          <div key={s.id} className="group flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent/40">
            <div className="min-w-0 flex-1">
              {editing === s.id ? (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(null); }}
                  className="h-7 w-full rounded-md border bg-card px-2 text-sm"
                />
              ) : (
                <span className="block truncate text-sm font-medium">{s.name}</span>
              )}
              {s.description && <span className="block truncate text-xs text-muted-foreground">{s.description}</span>}
              {(s.inputs?.length ?? 0) > 0 && (
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  inputs: {(s.inputs ?? []).join(', ')}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {editing === s.id ? (
                <button onClick={commitRename} className="rounded p-1 text-primary hover:bg-accent" title="Save name">✓</button>
              ) : (
                <button onClick={() => startRename(s)} className="rounded p-1 text-muted-foreground hover:bg-accent" title="Rename">
                  <PencilIcon className="size-3.5" />
                </button>
              )}
              <button
                onClick={() => { if (confirm(`Delete skill "${s.name}"?`)) acp({ type: 'acp/deleteSkill', id: s.id }); }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                title="Delete"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Settings
// ════════════════════════════════════════════════════════════════════════════
interface AgentStatus { installed: boolean; missing: string[] }
interface InstallState { agentId: string | null; log: string[]; error: string | null }

/**
 * Agent picker installer: checks which agent CLIs are on PATH and runs the
 * in-app installer (via the daemon) — no terminal needed.
 */
function AgentStatusSection() {
  const [status, setStatus] = useState<Record<string, AgentStatus>>({});
  const [inst, setInst] = useState<InstallState>({ agentId: null, log: [], error: null });

  useEffect(() => {
    const onMsg = (msg: any) => {
      const p = msg?.kind === 'ACP_UPDATE' ? msg.payload : null;
      if (!p) return;
      if (p.type === 'acp/agentStatus') {
        const m: Record<string, AgentStatus> = {};
        for (const s of p.status) m[s.id] = { installed: !!s.installed, missing: s.missing ?? [] };
        setStatus(m);
      } else if (p.type === 'acp/installStarted') {
        setInst({ agentId: p.agentId, log: [], error: null });
      } else if (p.type === 'acp/installLog') {
        setInst((prev) => (prev.agentId === p.agentId ? { ...prev, log: [...prev.log, p.line] } : prev));
      } else if (p.type === 'acp/installDone') {
        setInst((prev) => ({
          ...prev,
          agentId: null,
          error: p.ok ? null : (p.error ?? `"${p.agentId}" install failed — see log above.`),
        }));
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    acp({ type: 'acp/agentStatus' });
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const agents = AGENTS.filter((a) => a.id !== 'claude' && a.id !== 'custom');

  return (
    <section className="mb-6">
      <label className="mb-1 block text-xs font-medium">Installed agents</label>
      <div className="space-y-1">
        {agents.map((a) => {
          const st = status[a.id];
          const busy = inst.agentId === a.id;
          return (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className={st ? (st.installed ? 'text-emerald-500' : 'text-amber-500') : 'opacity-40'}>
                  {st ? (st.installed ? '✓' : '·') : '·'}
                </span>
                <span className="truncate">{a.label}</span>
              </span>
              {busy ? (
                <span className="shrink-0 text-muted-foreground">installing…</span>
              ) : st && !st.installed ? (
                <button
                  type="button"
                  onClick={() => acp({ type: 'acp/installAgent', agentId: a.id })}
                  className="shrink-0 cursor-pointer rounded bg-primary px-2 py-0.5 text-primary-foreground hover:opacity-90"
                >
                  Install
                </button>
              ) : (
                <span className="shrink-0 text-[10px] text-muted-foreground">installed</span>
              )}
            </div>
          );
        })}
      </div>
      {inst.agentId && inst.log.length > 0 && (
        <pre className="mt-2 max-h-32 overflow-auto rounded-md border bg-muted p-2 text-[10px] whitespace-pre-wrap">
          {inst.log.join('')}
        </pre>
      )}
      {inst.error && <p className="mt-2 text-xs text-destructive">{inst.error}</p>}
    </section>
  );
}

function SettingsPage({ bridge, onBack }: { bridge: boolean; onBack: () => void }) {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);

  const apply = (patch: Parameters<typeof update>[0]) => {
    void update(patch);
    if ('agentId' in patch || 'customCmd' in patch || 'customArgs' in patch || 'model' in patch || 'effort' in patch) resetSession();
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
          onChange={(e) => apply({ agentId: e.target.value as AgentId })}
          className="h-9 w-full rounded-md border bg-card px-2 text-sm"
        >
          {AGENTS.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
        </select>
        {active && <p className="mt-1.5 text-xs text-muted-foreground">{active.hint}</p>}

        <AgentStatusSection />

        {s.agentId === 'custom' && (
          <div className="mt-3 space-y-2">
            <input
              value={s.customCmd}
              onChange={(e) => apply({ customCmd: e.target.value })}
              placeholder="Command (e.g. npx)"
              className="h-8 w-full rounded-md border bg-card px-2 text-sm"
            />
            <input
              value={s.customArgs}
              onChange={(e) => apply({ customArgs: e.target.value })}
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

      <section className="mb-6">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={s.byoEnabled}
            onChange={(e) => apply({ byoEnabled: e.target.checked })}
          />
          Bring your own model / API key
        </label>
        {s.byoEnabled && (
          <div className="mt-2 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium">Provider</label>
              <select
                value={s.byoProvider}
                onChange={(e) => apply({ byoProvider: e.target.value })}
                className="h-9 w-full rounded-md border bg-card px-2 text-sm"
              >
                {Object.keys(BYO_ENV_KEY).map((p) => (<option key={p} value={p}>{p}</option>))}
              </select>
            </div>
            {AGENT_CAPS[s.agentId].byoFlags && (
              <div>
                <label className="mb-1 block text-xs font-medium">Model</label>
                <input
                  value={s.byoModel}
                  onChange={(e) => apply({ byoModel: e.target.value })}
                  placeholder="e.g. openrouter/gpt-5.4 / qwen3.5-plus"
                  className="h-8 w-full rounded-md border bg-card px-2 text-xs"
                />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium">API key</label>
              <input
                type="password"
                value={s.byoApiKey}
                onChange={(e) => apply({ byoApiKey: e.target.value })}
                placeholder={BYO_ENV_KEY[s.byoProvider] || 'provider key'}
                className="h-8 w-full rounded-md border bg-card px-2 font-mono text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Base URL (optional — proxy/router)</label>
              <input
                value={s.byoBaseUrl}
                onChange={(e) => apply({ byoBaseUrl: e.target.value })}
                placeholder="https://api.your-provider.example/v1"
                className="h-8 w-full rounded-md border bg-card px-2 font-mono text-xs"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Injected into the agent as <code>{BYO_ENV_KEY[s.byoProvider] || 'your provider env'}</code>
              {s.byoBaseUrl && BYO_BASE_URL_ENV[s.byoProvider] ? <> and <code>{BYO_BASE_URL_ENV[s.byoProvider]}</code></> : ''}.
              Works with Pi, OpenCode, Qwen, Kimi, Claude, Gemini. Key stays in this browser (not encrypted).
            </p>
          </div>
        )}
      </section>

      {s.agentId === 'claude' && (
        <section className="mb-6">
          <label className="mb-1 block text-xs font-medium">Model</label>
          <select
            value={s.model}
            onChange={(e) => apply({ model: e.target.value })}
            className="h-9 w-full rounded-md border bg-card px-2 text-sm"
          >
            {CLAUDE_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
          </select>
          <label className="mb-1 mt-3 block text-xs font-medium">Reasoning effort</label>
          <select
            value={s.effort}
            onChange={(e) => apply({ effort: e.target.value as 'low' | 'medium' | 'high' })}
            className="h-9 w-full rounded-md border bg-card px-2 text-sm"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Controls reasoning depth (Claude's effort setting). Higher = deeper reasoning, slower.
          </p>
        </section>
      )}

      <section className="mb-6">
        <label className="mb-1 block text-xs font-medium">Page control</label>
        <select
          value={s.pageMode}
          onChange={(e) => apply({ pageMode: e.target.value as 'dom' | 'cdp' })}
          className="h-9 w-full rounded-md border bg-card px-2 text-sm"
        >
          <option value="cdp">CDP (default) — native, like Claude in Chrome</option>
          <option value="dom">DOM — banner-free, content script</option>
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          CDP (default) attaches the debugger and shows a "Pilot is debugging this browser"
          banner while active — the same model Claude in Chrome uses, with a real accessibility
          tree. DOM reads the page via the content script instead (no banner, less detail).
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.autoScreenshot}
            onChange={(e) => apply({ autoScreenshot: e.target.checked })}
          />
          Send a viewport screenshot with each message (DOM mode only)
        </label>
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