/**
 * Extension settings, persisted to chrome.storage.local so they survive reloads
 * and service-worker restarts. The daemon can't read chrome.storage (it's a
 * separate node process), so the side panel sends the chosen agent (and, for a
 * custom agent, its command) along with each `acp/newSession`.
 */
export type AgentId = 'claude' | 'gemini' | 'codex' | 'pi' | 'opencode' | 'qwen' | 'kimi' | 'grok' | 'custom';

export interface AgentOption {
  id: AgentId;
  label: string;
  hint: string;
}

/** Shown in the picker. The daemon maps these ids to actual launch commands. */
export const AGENTS: AgentOption[] = [
  { id: 'claude', label: 'Claude Code', hint: 'Bundled · uses your Claude Code login (or BYO key)' },
  { id: 'gemini', label: 'Gemini CLI', hint: 'Needs `gemini` on PATH (--experimental-acp) · BYO key' },
  { id: 'codex', label: 'Codex', hint: 'Needs a Codex ACP adapter on PATH (ChatGPT login)' },
  { id: 'pi', label: 'Pi', hint: 'Model chosen inside Pi (`pi` → /model) · BYO key' },
  { id: 'opencode', label: 'OpenCode', hint: 'Open-source, multi-provider BYO (`opencode acp`)' },
  { id: 'qwen', label: 'Qwen Code', hint: 'Alibaba · BYO via provider (`qwen --acp`)' },
  { id: 'kimi', label: 'Kimi (Moonshot)', hint: 'Moonshot AI · BYO key (`kimi acp`)' },
  { id: 'grok', label: 'Grok (xAI)', hint: 'xAI · BYO key (`grok agent stdio`)' },
  { id: 'custom', label: 'Custom (ACP command)', hint: 'Any ACP agent — enter its command + args below' },
];

/**
 * Normalization layer: per-agent capabilities. The UI renders controls from
 * THIS (model picker, effort, BYO fields) and the daemon applies the matching
 * spawn/meta. Keeps agent quirks in one place instead of hardcoded lists.
 *
 *   modelControl: how the model is chosen.
 *     - 'presets'  → fixed list (Claude aliases)
 *     - 'freeform' → the CLI accepts --model, any string works
 *     - 'none'     → the agent picks its model from its own config (Pi, Gemini,
 *                    Kimi, Grok, Codex) — nothing Pilot can control
 *   effort: agent accepts a reasoning-depth control (Claude only today).
 *   byoFlags: agent CLI accepts --provider/--model on the spawn.
 *   byoEnv: provider API key can be injected via a standard env var.
 *   mcp: browser MCP can be attached in session/new (drives the page).
 */
export interface AgentCapabilities {
  modelControl: 'presets' | 'freeform' | 'none';
  effort: boolean;
  byoFlags: boolean;
  byoEnv: boolean;
  mcp: boolean;
}

export const AGENT_CAPS: Record<AgentId, AgentCapabilities> = {
  claude:   { modelControl: 'presets', effort: true,  byoFlags: false, byoEnv: true,  mcp: true },
  gemini:   { modelControl: 'none',    effort: false, byoFlags: false, byoEnv: true,  mcp: true },
  codex:    { modelControl: 'freeform', effort: false, byoFlags: false, byoEnv: false, mcp: true },
  pi:       { modelControl: 'none',    effort: false, byoFlags: false, byoEnv: true,  mcp: false },
  opencode: { modelControl: 'freeform', effort: false, byoFlags: true, byoEnv: true,  mcp: true },
  qwen:     { modelControl: 'freeform', effort: false, byoFlags: true, byoEnv: true,  mcp: true },
  kimi:     { modelControl: 'none',    effort: false, byoFlags: false, byoEnv: true,  mcp: true },
  grok:     { modelControl: 'none',    effort: false, byoFlags: false, byoEnv: true,  mcp: true },
  custom:   { modelControl: 'freeform', effort: false, byoFlags: false, byoEnv: true,  mcp: true },
};

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
  effort: 'low' | 'medium' | 'high'; // reasoning effort → thinking-token budget
  pageMode: 'dom' | 'cdp'; // how Pilot reads/controls the page (CDP = default, like Claude)
  autoScreenshot: boolean; // send a viewport screenshot with each turn — only used in DOM mode
  autoElements: boolean;   // append the current page's interactive elements to each turn
  // Bring-your-own-model: lets the chosen agent use your own provider/key instead
  // of its default login. Key is stored in chrome.storage (not encrypted).
  byoEnabled: boolean;
  byoProvider: string; // openai | anthropic | google | openrouter | ollama | ...
  byoModel: string;    // e.g. gpt-5.4 / claude-sonnet-4 / llama-3.3-70b
  byoApiKey: string;
  byoBaseUrl: string;  // optional proxy / custom endpoint
}

const KEY = 'pilot.settings';
const DEFAULT: Settings = {
  agentId: 'claude', customCmd: '', customArgs: '', model: '',
  effort: 'medium', pageMode: 'cdp', autoScreenshot: true, autoElements: true,
  byoEnabled: false, byoProvider: 'openai', byoModel: '', byoApiKey: '', byoBaseUrl: '',
};

/** Provider → the standard env var that holds its API key. */
export const BYO_ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  grok: 'XAI_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  ollama: '',
  local: '',
  custom: '',
};

/** Provider → the standard env var for a custom base URL (proxy/router). */
export const BYO_BASE_URL_ENV: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  google: 'GEMINI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
};

/** Providers a harness typically accepts --provider/--model flags for. */
export const BYO_FLAG_PROVIDERS = ['pi', 'qwen'];

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
