import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { DropdownMenu } from 'radix-ui';
import {
  SettingsIcon, ArrowLeftIcon, SquarePenIcon, HistoryIcon, MoreHorizontalIcon,
  Trash2Icon, PencilIcon, SparklesIcon, LoaderIcon,
} from 'lucide-react';
import { TooltipProvider } from '../../components/ui/tooltip';
import { Thread } from '../../components/thread';
import { MicButton } from '../../components/mic-button';
import { RecordingSteps } from '../../components/recording-steps';
import { cn } from '../../lib/utils';
import { acpAdapter, resetSession, resumeSession } from './adapter';
import { request, acp, type RecordedStep } from './bridge';
import { AGENTS, CLAUDE_MODELS, AGENT_CAPS, BYO_ENV_KEY, BYO_BASE_URL_ENV, type AgentId } from './settings';
import { useSettings } from './settings-store';

type View = 'chat' | 'settings' | 'history' | 'skills';

interface SkillStep { do: string; why?: string; live?: boolean }
interface SkillDraft {
  id?: string;
  name: string;
  description?: string;
  inputs?: string[];
  steps: SkillStep[];
  actions?: Array<Record<string, unknown>>;
}
type SkillFlow =
  | { status: 'generating' }
  | { status: 'draft'; draft: SkillDraft }
  | { status: 'error'; error: string };

/** Labels that name no specific element (so we fall back to a selector). */
const BARE_LABEL = /^(div|span|a|button|input|select|textarea|summary|li|ul|ol|p|i|b|em|strong|svg|path|label|form|section|article|header|footer|nav|img|td|tr|table|h[1-6])$/i;

/** Strip tracking / one-off query params so skills start from a stable URL. */
const TRACKING_PARAM = /^(utm_|gclid$|gad_|gbraid$|wbraid$|fbclid$|spm$|spm_|from_|userCode$|user_code$|share_)/i;
function cleanUrl(u: string): string {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.toString();
  } catch { return u; }
}

/** Compact a recording for the skill-authoring prompt (cut tokens). */
function compactSteps(steps: RecordedStep[]) {
  return steps.map((s, i) => {
    if (s.type === 'note') return { n: i + 1, note: s.label };
    if (s.type === 'navigate') return { n: i + 1, act: 'navigate', to: cleanUrl(s.url || s.label) };
    const el = s.label?.trim();
    const unhelpful = !el || BARE_LABEL.test(el);
    return {
      n: i + 1,
      act: s.type,
      el: unhelpful ? undefined : el,
      value: s.value || undefined,
      // Selector only when the label can't identify the element (token-saving).
      sel: unhelpful && s.selector ? s.selector.slice(0, 90) : undefined,
    };
  });
}

/** Deterministic replay actions from a recording (no model needed to replay). */
function buildActions(steps: RecordedStep[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of steps) {
    if (s.type === 'navigate') out.push({ act: 'navigate', to: s.url || s.label });
    else if (s.type === 'click') out.push({ act: 'click', sel: s.selector || undefined, el: s.label || undefined });
    else if (s.type === 'input') out.push({ act: 'input', sel: s.selector || undefined, el: s.label || undefined, value: s.value });
    else if (s.type === 'change') out.push({ act: 'change', sel: s.selector || undefined, el: s.label || undefined, value: s.value });
  }
  return out;
}

export default function App() {
  const [bridge, setBridge] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [tab, setTab] = useState<{ title: string; url: string }>({ title: '', url: '' });
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stepCount, setStepCount] = useState(0);
  const [noteText, setNoteText] = useState('');
  const [threadKey, setThreadKey] = useState(0);
  const [dictation, setDictation] = useState<{ listening: boolean; pending: boolean }>({ listening: false, pending: false });
  const [skillFlow, setSkillFlow] = useState<SkillFlow | null>(null);
  const wasRecording = useRef(false);
  const lastSteps = useRef<RecordedStep[]>([]);
  const loadSettings = useSettings((s) => s.load);
  const settings = useSettings((s) => s.settings);

  useEffect(() => {
    void loadSettings();
    const onMsg = (msg: any) => {
      if (msg?.type === 'STATE') {
        setBridge(!!msg.bridgeConnected);
        setRecording(!!msg.isRecording);
        setPaused(!!msg.paused);
        setStepCount((msg.steps ?? []).length);
        const steps: RecordedStep[] = msg.steps ?? [];
        // Recording just stopped → author a skill in the background (no chat dump).
        if (wasRecording.current && !msg.isRecording && steps.length > 0) {
          lastSteps.current = steps;
          setView('chat');
          setSkillFlow({ status: 'generating' });
          const cur = useSettings.getState().settings;
          acp({
            type: 'acp/authorSkill',
            actions: buildActions(steps),
            notes: steps.filter((s) => s.type === 'note').map((s) => s.label),
            agentId: cur.agentId, model: cur.model, effort: cur.effort,
          });
        }
        wasRecording.current = !!msg.isRecording;
      } else if (msg?.type === 'ACTIVE_TAB') {
        setTab({ title: msg.title ?? '', url: msg.url ?? '' });
      } else if (msg?.kind === 'ACP_UPDATE') {
        const p = msg.payload;
        if (p?.type === 'acp/skillDraft') { setView('chat'); setSkillFlow({ status: 'draft', draft: p.draft as SkillDraft }); }
        else if (p?.type === 'acp/skillDraftError') setSkillFlow({ status: 'error', error: p.message });
        else if (p?.type === 'acp/skillSaved') setSkillFlow(null);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const onDictation = (e: Event) =>
      setDictation((e as CustomEvent<{ listening: boolean; pending: boolean }>).detail);
    window.addEventListener('pilot:dictation', onDictation as EventListener);
    request({ type: 'GET_STATE' }).then((r: any) => {
      if (!r) return;
      setBridge(!!r.bridgeConnected);
      setRecording(!!r.isRecording);
      setPaused(!!r.paused);
      setStepCount((r.steps ?? []).length);
      wasRecording.current = !!r.isRecording;
    });
    request({ type: 'GET_PAGE_CONTEXT' }).then((r: any) => { if (r) setTab({ title: r.title ?? '', url: r.url ?? '' }); });
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      window.removeEventListener('pilot:dictation', onDictation as EventListener);
    };
  }, [loadSettings]);

  function sendNote() {
    const t = noteText.trim();
    if (!t) return;
    setNoteText('');
    chrome.runtime.sendMessage({ type: 'NOTE', text: t }).catch(() => {});
  }

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
        {/* Header: back (when not on chat) · history · new chat · menu */}
        <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-1">
            {view !== 'chat' && (
              <button
                onClick={() => setView('chat')}
                className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Back to chat"
                title="Back to chat"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            )}
            <span className="truncate text-sm font-semibold">
              {view === 'chat' ? 'Pilot' : view === 'settings' ? 'Settings' : view === 'history' ? 'History' : 'Skills'}
            </span>
          </div>
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
          <SettingsPage bridge={bridge} />
        ) : view === 'history' ? (
          <HistoryPage onContinue={continueChat} />
        ) : view === 'skills' ? (
          <SkillsPage />
        ) : skillFlow ? (
          <SkillDraftCard
            flow={skillFlow}
            onDiscard={() => setSkillFlow(null)}
            onRetry={() => {
              setSkillFlow(null);
              chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((r: any) => {
                if (r?.steps?.length) {
                  lastSteps.current = r.steps;
                  setSkillFlow({ status: 'generating' });
                  acp({
                    type: 'acp/authorSkill',
                    actions: buildActions(r.steps),
                    notes: r.steps.filter((s: any) => s.type === 'note').map((s: any) => s.label),
                    agentId: settings.agentId, model: settings.model, effort: settings.effort,
                  });
                }
              }).catch(() => {});
            }}
            onSave={(skill) => acp({ type: 'acp/saveSkill', skill: {
              id: skill.id, name: skill.name, description: skill.description, inputs: skill.inputs,
              steps: skill.steps.map((s) => s.do),
              actions: skill.actions,
            } })}
          />
        ) : (
          <>
            {recording ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b bg-red-50 px-3 py-1.5 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  <span className={'inline-block h-2 w-2 rounded-full bg-red-500' + (paused ? '' : ' animate-pulse')} />
                  <span>{paused ? 'Paused' : 'Recording'} · {stepCount} step{stepCount === 1 ? '' : 's'}</span>
                  <span className="truncate text-red-600/80 dark:text-red-300/80">
                    {dictation.listening ? '· 🎤 listening…' : dictation.pending ? '· 🎤 allow mic…' : '· 🎤 tap to narrate'}
                  </span>
                </div>
                <RecordingSteps />
                {/* Bottom control bar: note input · dictate · pause · stop */}
                <div className="flex shrink-0 items-center gap-1.5 border-t px-2 py-2">
                  <input
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') sendNote(); }}
                    placeholder="Type a note…"
                    className="h-8 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs"
                  />
                  <button
                    onClick={sendNote}
                    className="shrink-0 cursor-pointer rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    Note
                  </button>
                  <MicButton />
                  <button
                    onClick={() => chrome.runtime.sendMessage({ type: paused ? 'RESUME' : 'PAUSE' }).catch(() => {})}
                    className="shrink-0 cursor-pointer rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    onClick={() => chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {})}
                    className="shrink-0 cursor-pointer rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700"
                  >
                    ■ Stop
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={tab.url || undefined}>
                    ▸ Tab: {tab.title || tab.url || 'no active tab'}
                  </span>
                </div>
                <ConnectBanner />
              </>
            )}
            <div className={recording ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
              <Chat key={threadKey} />
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Chat — owns the runtime (remounted on "New chat")
// ════════════════════════════════════════════════════════════════════════════
function Chat() {
  const runtime = useLocalRuntime(acpAdapter);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  function append(text: string) {
    try {
      (runtimeRef.current as any).thread.append({ role: 'user', content: [{ type: 'text', text }] });
    } catch { /* runtime not ready */ }
  }

  useEffect(() => {
    // Fired by the composer "+" menu to run a skill / attach content in this thread.
    const onRun = (e: Event) => append((e as CustomEvent<string>).detail);
    const onRunParts = (e: Event) => {
      try {
        (runtimeRef.current as any).thread.append({ role: 'user', content: (e as CustomEvent<any[]>).detail });
      } catch { /* runtime not ready */ }
    };
    window.addEventListener('pilot:run', onRun as EventListener);
    window.addEventListener('pilot:runParts', onRunParts as EventListener);
    return () => {
      window.removeEventListener('pilot:run', onRun as EventListener);
      window.removeEventListener('pilot:runParts', onRunParts as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

function HistoryPage({ onContinue }: { onContinue: (id: string) => void }) {
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

function SkillsPage() {
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
interface AgentStatus { installed: boolean; missing: string[]; connectable?: boolean }
interface InstallState { agentId: string | null; log: string[]; error: string | null }

/** Scan which agent harnesses are installed / connectable (from the daemon). */
function useAgentScan() {
  const [status, setStatus] = useState<Record<string, AgentStatus>>({});
  const [mcpPath, setMcpPath] = useState('');
  useEffect(() => {
    const onMsg = (msg: any) => {
      const p = msg?.kind === 'ACP_UPDATE' ? msg.payload : null;
      if (p?.type !== 'acp/agentStatus') return;
      const m: Record<string, AgentStatus> = {};
      for (const st of p.status) {
        m[st.id] = { installed: !!st.installed, missing: st.missing ?? [], connectable: !!st.connectable };
      }
      setStatus(m);
      if (p.mcpPath) setMcpPath(p.mcpPath);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    acp({ type: 'acp/agentStatus' });
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  return { status, mcpPath };
}

/** A titled settings block. */
function Section({ title, note, right, children }: {
  title: string; note?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="border-b py-4 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {right}
      </div>
      {note && <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{note}</p>}
      {children}
    </section>
  );
}

/**
 * One-click offer (top of the home view) to register this browser MCP with the
 * other agents installed on the machine — no copy-paste. Dismissible; the
 * Settings page keeps the same action plus the raw commands.
 */
function ConnectBanner() {
  const [hidden, setHidden] = useState(true);
  const { status } = useAgentScan();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local
      .get('pilot.connectNoticeDismissed')
      .then((r) => setHidden(!!r['pilot.connectNoticeDismissed']))
      .catch(() => setHidden(false));
    const onMsg = (msg: any) => {
      const p = msg?.kind === 'ACP_UPDATE' ? msg.payload : null;
      if (p?.type === 'acp/connectResult' && p.ok) {
        setBusy(null);
        setDone(AGENTS.find((a) => a.id === p.agentId)?.label ?? p.agentId);
        setTimeout(() => dismiss(), 4000);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    setHidden(true);
    chrome.storage.local.set({ 'pilot.connectNoticeDismissed': true }).catch(() => {});
  }

  if (hidden) return null;
  const candidates = AGENTS.filter(
    (a) => a.id !== 'custom' && status[a.id]?.installed && status[a.id]?.connectable,
  );
  if (candidates.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px]">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {done ? `✓ ${done} connected — restart it to load the browser tools.` : 'Let other agents drive this browser too:'}
      </span>
      {!done &&
        candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={busy !== null}
            onClick={() => { setBusy(c.id); acp({ type: 'acp/connectAgent', agentId: c.id }); }}
            className="shrink-0 cursor-pointer rounded border bg-card px-2 py-0.5 hover:text-foreground disabled:opacity-50"
          >
            {busy === c.id ? 'Connecting…' : `Connect ${c.label}`}
          </button>
        ))}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 cursor-pointer px-1 text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
      className="shrink-0 cursor-pointer rounded border bg-card px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Background skill authoring: generating → editable draft (confirm) → save. */
function SkillDraftCard({ flow, onSave, onDiscard, onRetry }: {
  flow: SkillFlow;
  onSave: (skill: SkillDraft) => void;
  onDiscard: () => void;
  onRetry: () => void;
}) {
  if (flow.status === 'generating') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm">Generating a skill from your recording…</p>
        <p className="text-[11px] text-muted-foreground">Runs in the background — nothing is added to the chat.</p>
      </div>
    );
  }
  if (flow.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{flow.error}</p>
        <div className="flex gap-2">
          <button onClick={onRetry} className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Try again</button>
          <button onClick={onDiscard} className="cursor-pointer rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Discard</button>
        </div>
      </div>
    );
  }
  return <SkillDraftEditor draft={flow.draft} onSave={onSave} onDiscard={onDiscard} />;
}

function SkillDraftEditor({ draft, onSave, onDiscard }: {
  draft: SkillDraft;
  onSave: (skill: SkillDraft) => void;
  onDiscard: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description ?? '');
  const [inputs, setInputs] = useState<string[]>(draft.inputs ?? []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <h2 className="mb-1 text-sm font-semibold">Save this skill?</h2>
      <p className="mb-4 text-[11px] text-muted-foreground">Generated from your recording. Edit anything before saving.</p>

      <label className="mb-1 block text-[11px] text-muted-foreground">Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} className="mb-3 h-9 w-full rounded-md border bg-card px-2 text-sm" />

      <label className="mb-1 block text-[11px] text-muted-foreground">Description</label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="mb-3 w-full resize-none rounded-md border bg-card px-2 py-1 text-sm"
      />

      <label className="mb-1 block text-[11px] text-muted-foreground">Inputs (variables)</label>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {inputs.length === 0 && <span className="text-[11px] text-muted-foreground">none</span>}
        {inputs.map((v, i) => (
          <span key={`${v}-${i}`} className="flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[11px]">
            {v}
            <button
              onClick={() => setInputs(inputs.filter((_, j) => j !== i))}
              aria-label={`Remove ${v}`}
              className="cursor-pointer text-muted-foreground hover:text-destructive"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <label className="mb-1 block text-[11px] text-muted-foreground">Steps</label>
      <ol className="mb-4 space-y-1.5 text-xs">
        {draft.steps.map((st, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
            <span className="min-w-0 flex-1">
              <span className="block break-words">{st.do}</span>
              {st.why && <span className="mt-0.5 block text-[11px] text-muted-foreground italic">{st.why}</span>}
            </span>
            {st.live && (
              <span
                title="Depends on live page state — the agent re-checks it at replay"
                className="h-fit shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              >
                LIVE
              </span>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-auto flex items-center gap-2 py-2">
        <button
          onClick={() => onSave({ name: name.trim() || draft.name, description: description.trim(), inputs, steps: draft.steps, actions: draft.actions })}
          className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Save skill
        </button>
        <button onClick={onDiscard} className="cursor-pointer rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
          Discard
        </button>
      </div>
    </div>
  );
}

function SettingsPage({ bridge }: { bridge: boolean }) {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const { status, mcpPath } = useAgentScan();

  const [inst, setInst] = useState<InstallState>({ agentId: null, log: [], error: null });
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    const onMsg = (msg: any) => {
      const p = msg?.kind === 'ACP_UPDATE' ? msg.payload : null;
      if (!p) return;
      if (p.type === 'acp/agentModels') setModels(p.models ?? []);
      else if (p.type === 'acp/installStarted') {
        setInst({ agentId: p.agentId, log: [], error: null });
      } else if (p.type === 'acp/installLog') {
        setInst((prev) => (prev.agentId === p.agentId ? { ...prev, log: [...prev.log, p.line] } : prev));
      } else if (p.type === 'acp/installDone') {
        setInst((prev) => ({
          ...prev,
          agentId: null,
          error: p.ok ? null : (p.error ?? `"${p.agentId}" install failed — see log above.`),
        }));
      } else if (p.type === 'acp/connectResult') {
        setConnectBusy(null);
        if (p.ok) setConnected(AGENTS.find((a) => a.id === p.agentId)?.label ?? p.agentId);
        else setInst((prev) => ({ ...prev, error: p.output || `Could not connect ${p.agentId}.` }));
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // Fetch the model list for agents that expose one (e.g. `opencode models`).
  useEffect(() => {
    if (s?.agentId === 'opencode') acp({ type: 'acp/agentModels', agentId: 'opencode' });
    else setModels([]);
  }, [s?.agentId]);

  const apply = (patch: Parameters<typeof update>[0]) => {
    void update(patch);
    if ('agentId' in patch || 'customCmd' in patch || 'customArgs' in patch || 'model' in patch || 'effort' in patch) resetSession();
  };

  if (!s) return null;
  const active = AGENTS.find((a) => a.id === s.agentId);

  const installedAgents = AGENTS.filter((a) => a.id !== 'custom' && status[a.id]?.installed);
  const otherAgents = AGENTS.filter((a) => a.id !== 'custom' && status[a.id] && !status[a.id]!.installed);
  const connectable = AGENTS.filter(
    (a) => a.id !== 'custom' && status[a.id]?.installed && status[a.id]?.connectable,
  );
  const commands: Array<[string, string]> = mcpPath
    ? [
        ['Claude Code', `claude mcp add pilot --scope user -- node "${mcpPath}"`],
        ['Codex', `codex mcp add pilot -- node "${mcpPath}"`],
        ['OpenCode', `opencode mcp add pilot -- node "${mcpPath}"`],
      ]
    : [];

  const selectCls = 'h-9 w-full rounded-md border bg-card px-2 text-sm';
  const inputCls = 'h-8 w-full rounded-md border bg-card px-2 text-sm';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
      {/* ── Agent ───────────────────────────────────────────────── */}
      <Section title="Agent" note="Changing the agent starts a fresh conversation.">
        <select value={s.agentId} onChange={(e) => apply({ agentId: e.target.value as AgentId })} className={selectCls}>
          {AGENTS.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
        </select>
        {active && <p className="mt-1.5 text-xs text-muted-foreground">{active.hint}</p>}

        {s.agentId === 'opencode' && models.length > 0 && (
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] text-muted-foreground">Model</span>
            <select value={s.model} onChange={(e) => apply({ model: e.target.value })} className={selectCls}>
              <option value="">Default</option>
              {models.map((m) => (<option key={m} value={m}>{m}</option>))}
            </select>
          </label>
        )}

        {s.agentId === 'custom' && (
          <div className="mt-3 space-y-2">
            <input
              value={s.customCmd}
              onChange={(e) => apply({ customCmd: e.target.value })}
              placeholder="Command (e.g. npx)"
              className={inputCls}
            />
            <input
              value={s.customArgs}
              onChange={(e) => apply({ customArgs: e.target.value })}
              placeholder="Args (e.g. -y some-acp-agent --stdio)"
              className={`${inputCls} font-mono text-xs`}
            />
          </div>
        )}

        {s.agentId === 'claude' && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Model</span>
              <select value={s.model} onChange={(e) => apply({ model: e.target.value })} className={selectCls}>
                {CLAUDE_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Reasoning effort</span>
              <select
                value={s.effort}
                onChange={(e) => apply({ effort: e.target.value as 'low' | 'medium' | 'high' })}
                className={selectCls}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
        )}
      </Section>

      {/* ── BYO model / key ─────────────────────────────────────── */}
      <Section title="Model & API key">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={s.byoEnabled} onChange={(e) => apply({ byoEnabled: e.target.checked })} />
          Bring your own model / API key
        </label>
        {s.byoEnabled && (
          <div className="mt-2 space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Provider</span>
              <select value={s.byoProvider} onChange={(e) => apply({ byoProvider: e.target.value })} className={selectCls}>
                {Object.keys(BYO_ENV_KEY).map((p) => (<option key={p} value={p}>{p}</option>))}
              </select>
            </label>
            {AGENT_CAPS[s.agentId].byoFlags && (
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">Model</span>
                <input
                  value={s.byoModel}
                  onChange={(e) => apply({ byoModel: e.target.value })}
                  placeholder="e.g. openrouter/gpt-5.4"
                  className={inputCls}
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">API key</span>
              <input
                type="password"
                value={s.byoApiKey}
                onChange={(e) => apply({ byoApiKey: e.target.value })}
                placeholder={BYO_ENV_KEY[s.byoProvider] || 'provider key'}
                className={`${inputCls} font-mono text-xs`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Base URL (optional)</span>
              <input
                value={s.byoBaseUrl}
                onChange={(e) => apply({ byoBaseUrl: e.target.value })}
                placeholder="https://api.your-provider.example/v1"
                className={`${inputCls} font-mono text-xs`}
              />
            </label>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Injected into the agent as <code>{BYO_ENV_KEY[s.byoProvider] || 'your provider env'}</code>. Key stays in this browser (not encrypted).
            </p>
          </div>
        )}
      </Section>

      {/* ── Agents on this machine ──────────────────────────────── */}
      <Section
        title="Agents on this machine"
        right={
          <button
            type="button"
            onClick={() => setShowAllAgents((v) => !v)}
            className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showAllAgents ? 'Hide' : 'Install more'}
          </button>
        }
      >
        <div className="space-y-1">
          {(showAllAgents ? [...installedAgents, ...otherAgents] : installedAgents).map((a) => {
            const st = status[a.id];
            const busy = inst.agentId === a.id;
            return (
              <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={st?.installed ? 'text-emerald-500' : 'text-amber-500'}>
                    {st?.installed ? '✓' : '·'}
                  </span>
                  <span className="truncate">{a.label}</span>
                </span>
                {busy ? (
                  <span className="shrink-0 text-muted-foreground">installing…</span>
                ) : st?.installed ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">installed</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => acp({ type: 'acp/installAgent', agentId: a.id })}
                    className="shrink-0 cursor-pointer rounded bg-primary px-2 py-0.5 text-primary-foreground hover:opacity-90"
                  >
                    Install
                  </button>
                )}
              </div>
            );
          })}
          {installedAgents.length === 0 && <p className="text-[11px] text-muted-foreground">Scanning…</p>}
        </div>
        {inst.agentId && inst.log.length > 0 && (
          <pre className="mt-2 max-h-32 overflow-auto rounded-md border bg-muted p-2 text-[10px] whitespace-pre-wrap">
            {inst.log.join('')}
          </pre>
        )}
      </Section>

      {/* ── Connect other agents ────────────────────────────────── */}
      <Section
        title="Connect other agents"
        note="Let Codex / Claude Code / OpenCode drive this browser too. Then skills Pilot exports work there, and a browser launches automatically if none is open."
      >
        {connectable.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {connectable.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={connectBusy !== null}
                onClick={() => { setConnectBusy(a.id); setConnected(null); acp({ type: 'acp/connectAgent', agentId: a.id }); }}
                className="cursor-pointer rounded-md border bg-card px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
              >
                {connectBusy === a.id ? 'Connecting…' : `Connect ${a.label}`}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">No connectable agents found on this machine.</p>
        )}
        {connected && (
          <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
            ✓ {connected} connected — restart it to load the browser tools.
          </p>
        )}

        {commands.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowCommands((v) => !v)}
              className="mt-2 cursor-pointer text-[11px] text-muted-foreground underline hover:text-foreground"
            >
              {showCommands ? 'Hide commands' : 'Copy commands instead'}
            </button>
            {showCommands && (
              <div className="mt-2 space-y-2">
                {commands.map(([label, cmd]) => (
                  <div key={label}>
                    <div className="mb-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
                    <div className="flex items-start gap-1">
                      <code className="min-w-0 flex-1 rounded bg-muted px-1.5 py-1 text-[10px] break-all">{cmd}</code>
                      <CopyButton text={cmd} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Section>

      {/* ── Page control ────────────────────────────────────────── */}
      <Section
        title="Page control"
        note={s.pageMode === 'cdp'
          ? 'Native accessibility tree via the debugger (shows the "Pilot is debugging this browser" banner) — like Claude in Chrome.'
          : 'Reads the page through the content script — no debugger banner, but less detail.'}
      >
        <select value={s.pageMode} onChange={(e) => apply({ pageMode: e.target.value as 'dom' | 'cdp' })} className={selectCls}>
          <option value="cdp">CDP — native, like Claude in Chrome</option>
          <option value="dom">DOM — banner-free</option>
        </select>
        {s.pageMode === 'dom' && (
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={s.autoScreenshot} onChange={(e) => apply({ autoScreenshot: e.target.checked })} />
            Send a viewport screenshot with each message
          </label>
        )}
      </Section>

      {/* ── Connection ──────────────────────────────────────────── */}
      <Section title="Connection">
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('inline-block h-2.5 w-2.5 rounded-full', bridge ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          {bridge ? 'Connected to the local agent bridge' : 'Offline — is the daemon running?'}
        </div>
      </Section>

      {inst.error && <p className="py-2 text-xs text-destructive">{inst.error}</p>}
    </div>
  );
}
