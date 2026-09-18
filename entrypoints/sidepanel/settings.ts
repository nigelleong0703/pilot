/**
 * Extension settings, persisted to chrome.storage.local so they survive reloads
 * and service-worker restarts. The daemon can't read chrome.storage (it's a
 * separate node process), so the side panel sends the chosen agent (and, for a
 * custom agent, its command) along with each `acp/newSession`.
 */
export type AgentId = 'claude' | 'gemini' | 'codex' | 'pi' | 'custom';

export interface AgentOption {
  id: AgentId;
  label: string;
  hint: string;
}

/** Shown in the picker. The daemon maps these ids to actual launch commands. */
export const AGENTS: AgentOption[] = [
  { id: 'claude', label: 'Claude Code', hint: 'Bundled · uses your Claude Code login' },
  { id: 'gemini', label: 'Gemini CLI', hint: 'Needs `gemini` on PATH (--experimental-acp)' },
  { id: 'codex', label: 'Codex', hint: 'Needs a Codex ACP adapter on PATH' },
  { id: 'pi', label: 'Pi', hint: 'Needs the pi-acp adapter on PATH (bridges to `pi --mode rpc`)' },
  { id: 'custom', label: 'Custom (ACP command)', hint: 'Any ACP agent — enter its command + args below' },
];

/** Claude model choices (Claude Agent SDK aliases). Empty = agent default. */
export const CLAUDE_MODELS = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'haiku', label: 'Claude Haiku' },
];

export interface Settings {
  agentId: AgentId;
  customCmd: string;
  customArgs: string;
  model: string;       // Claude model alias ('' = default)
  thinking: boolean;   // show the agent's reasoning
  pageMode: 'dom' | 'cdp'; // how Pilot reads/controls the page
}

const KEY = 'pilot.settings';
const DEFAULT: Settings = { agentId: 'claude', customCmd: '', customArgs: '', model: '', thinking: false, pageMode: 'cdp' };

export async function loadSettings(): Promise<Settings> {
  try {
    const r = await chrome.storage.local.get(KEY);
    return { ...DEFAULT, ...(r[KEY] ?? {}) };
  } catch {
    return DEFAULT;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  try {
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* storage unavailable */
  }
  return next;
}
