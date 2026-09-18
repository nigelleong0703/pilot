#!/usr/bin/env node
/**
 * Browser Extension bridge daemon.
 *
 * One long-lived broker with THREE jobs:
 *
 *   1. Browser control (unchanged): MCP servers (index.js) on CLIENT_PORT issue
 *      commands; the extension on EXT_PORT executes them; replies route back by id.
 *
 *   2. Chat / ACP: the browser side panel is an ACP *front end*. The daemon runs
 *      the agent (claude-code-acp) as a subprocess, streams its output back to the
 *      side panel, and hands the agent the browser MCP so it can drive the page.
 *
 *   3. Recorder -> skill: recorded steps are handed to the agent to author a skill.
 *
 *        side panel --acp/*-->  daemon --stdio--> claude-code-acp --> Claude
 *                                 |                     |
 *                                 |                     +--MCP--> index.js --> extension --> page
 *                                 +--commands--> extension --> page
 *
 * Only one daemon can own the ports; a second instance exits on EADDRINUSE.
 * stdout is unused; logs go to stderr.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { AcpClient, type McpServerSpec, type AgentSpawn } from './acp-client.js';
import { ChatStore } from './chat-store.js';
import { SkillStore } from './skill-store.js';

// Tee logs to ~/.pilot/daemon.log — the daemon runs hidden, so this is how we
// see agent stderr and command flow for debugging.
try {
  const dir = join(homedir(), '.pilot');
  mkdirSync(dir, { recursive: true });
  const logStream = createWriteStream(join(dir, 'daemon.log'), { flags: 'a' });
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try { logStream.write(new Date().toISOString() + ' ' + args.map(String).join(' ') + '\n'); } catch { /* ignore */ }
    orig(...args);
  };
  console.error('[daemon] --- started, logging to', join(dir, 'daemon.log'), '---');
} catch { /* logging unavailable */ }

const EXT_PORT = Number(process.env.MCP_BRIDGE_PORT ?? 9234);
const CLIENT_PORT = Number(process.env.MCP_BRIDGE_CLIENT_PORT ?? 9235);
const INDEX_JS = resolvePath(dirname(fileURLToPath(import.meta.url)), 'index.js');

// ── On-demand browser launch ────────────────────────────────────────────────
// If an MCP client asks for a page action while no extension is connected, start
// a browser with the Pilot extension loaded so agents work even when the user
// hasn't opened a browser. Override with PILOT_BROWSER_BIN / PILOT_EXTENSION_PATH
// / PILOT_BROWSER_HEADLESS=1.
const EXT_PATH = process.env.PILOT_EXTENSION_PATH
  ?? resolvePath(dirname(INDEX_JS), '..', '..', '.output', 'chrome-mv3');

function findBrowserBinary(): string | undefined {
  const explicit = process.env.PILOT_BROWSER_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates: string[] = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
        ];
  return candidates.find((p) => p && existsSync(p));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let lastLaunchAt = 0;
function launchBrowser(): void {
  if (process.env.PILOT_NO_AUTOLAUNCH === '1') return;
  if (Date.now() - lastLaunchAt < 30_000) return; // cooldown between attempts
  lastLaunchAt = Date.now();
  if (!existsSync(EXT_PATH)) {
    console.error(`[daemon] auto-launch skipped: extension not built at ${EXT_PATH} (run "npm run build")`);
    return;
  }
  const bin = findBrowserBinary();
  if (!bin) {
    console.error('[daemon] auto-launch skipped: no Chrome/Edge/Chromium found (set PILOT_BROWSER_BIN)');
    return;
  }
  const profile = join(homedir(), '.pilot', 'browser');
  try { mkdirSync(profile, { recursive: true }); } catch { /* ignore */ }
  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome 137+ blocks --load-extension unless this feature is disabled.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--load-extension=${EXT_PATH}`,
    `--disable-extensions-except=${EXT_PATH}`,
  ];
  if (process.env.PILOT_BROWSER_HEADLESS === '1') args.push('--headless=new');
  args.push('about:blank');
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    console.error(`[daemon] launched browser for agent control: ${bin}`);
  } catch (e) {
    console.error('[daemon] browser launch failed:', String((e as any)?.message ?? e));
  }
}

/** Wait for an extension connection, launching a browser first if needed. */
async function ensureExtension(timeoutMs = 25_000): Promise<boolean> {
  const connected = () => !!extension && extension.readyState === extension.OPEN;
  if (connected()) return true;
  launchBrowser();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(400);
    if (connected()) return true;
  }
  return false;
}


// ── Agent registry ──────────────────────────────────────────────────────────
// Each ACP agent = how to launch it + which per-session `_meta` it understands.
// The side panel picks an agent id; the daemon maps it here.
const win = process.platform === 'win32';
const splitArgs = (s: string | undefined) => (s ? s.trim().split(/\s+/) : []);

/** Claude Code via the bundled adapter (no global install / PATH needed). */
function claudeSpawn(): AgentSpawn {
  if (process.env.ACP_AGENT_CMD) {
    return { command: process.env.ACP_AGENT_CMD, args: splitArgs(process.env.ACP_AGENT_ARGS), shell: win };
  }
  try {
    const require = createRequire(import.meta.url);
    const bin = require.resolve('@zed-industries/claude-code-acp/dist/index.js');
    return { command: process.execPath, args: [bin], shell: false };
  } catch {
    return { command: win ? 'claude-code-acp.cmd' : 'claude-code-acp', args: [], shell: win };
  }
}

/**
 * Claude honors _meta.systemPrompt + _meta.claudeCode.options.
 *
 * Tool isolation: `disableBuiltInTools` tells claude-code-acp to disallow EVERY
 * built-in Claude Code tool (Bash, Edit, WebSearch, TodoWrite, Task…). This is
 * the reliable switch — `tools: []` / `allowedTools` in claudeCode.options are
 * overwritten by the adapter (it forces `tools: { preset: claude_code }` and
 * derives allowedTools from fs/terminal capabilities), so we don't rely on
 * them. The model then only ever sees the browser MCP tools — same shape as
 * Claude in Chrome's curated browser-only toolset.
 */
function claudeMeta(model?: string, effort?: 'low' | 'medium' | 'high') {
  const options: Record<string, unknown> = {
    tools: [],
    allowedTools: ['mcp__browser'],
    // Reasoning depth. The old `maxThinkingTokens` is deprecated and on current
    // models is only on/off, so we use the SDK's `effort` option instead — the
    // same knob Claude in Chrome exposes (low/medium/high reasoning).
    ...(effort && { effort }),
  };
  if (model) options.model = model; // Claude Agent SDK model alias (opus/sonnet/haiku)
  return { systemPrompt: PILOT_SYSTEM_PROMPT, disableBuiltInTools: true, claudeCode: { options } };
}
/** Other ACP agents: steer via systemPrompt only (claudeCode options are ignored). */
function genericMeta() {
  return { systemPrompt: PILOT_SYSTEM_PROMPT };
}

const PILOT_SYSTEM_PROMPT =
  'You are Pilot. You control the user\'s browser through the "browser" MCP ' +
  'server (browser_list_tabs, browser_navigate, browser_snapshot, browser_click, browser_type, ' +
  'browser_select_option, browser_get_text, browser_screenshot). The tabs you act on live in the ' +
  '"Pilot" tab group: browser_list_tabs lists them and each has a tabId you can pass to the other ' +
  'tools to work across several tabs at once. Every message includes the page the user is currently ' +
  'viewing. ' +
  'ALWAYS use these browser_* tools for any web browsing or page interaction — never launch a ' +
  'separate or headless browser, and do not browse the web with any other tool. These browser_* ' +
  'tools are your ONLY tools; do not search for other tools. Typical flow: browser_snapshot -> ' +
  'browser_click/browser_type; browser_get_text to read the page. You can also record the user\'s ' +
  'actions and author skills via the recorder_* tools.';

interface AgentDef { spawn: () => AgentSpawn; meta: () => unknown; mcp: boolean; }
const AGENTS: Record<string, AgentDef> = {
  claude: { spawn: claudeSpawn, meta: claudeMeta, mcp: true },
  gemini: {
    // Verified (2026-08): Gemini CLI ACP mode accepts client stdio MCP servers in
    // session/new. `--experimental-acp` is the legacy flag; `--acp` is newer.
    spawn: () => ({ command: process.env.ACP_GEMINI_CMD ?? 'gemini', args: splitArgs(process.env.ACP_GEMINI_ARGS) .length ? splitArgs(process.env.ACP_GEMINI_ARGS) : ['--experimental-acp'], shell: win }),
    meta: genericMeta,
    mcp: true,
  },
  codex: {
    // Verified (2026-08): @agentclientprotocol/codex-acp accepts client MCP servers
    // in session/new (stdio + http). It IGNORES _meta.systemPrompt, so the Pilot
    // instructions are passed via CODEX_CONFIG.developer_instructions instead
    // (the channel the ai-sdk harness maps instructions to). Browser MCP is the
    // only tool source injected; INITIAL_AGENT_MODE default 'agent' is fine.
    spawn: () => {
      let codexConfig: Record<string, unknown> = {};
      if (process.env.CODEX_CONFIG) {
        try { codexConfig = JSON.parse(process.env.CODEX_CONFIG); } catch { /* keep {} */ }
      }
      codexConfig.developer_instructions = PILOT_SYSTEM_PROMPT;
      return {
        command: process.env.ACP_CODEX_CMD ?? 'npx',
        args: splitArgs(process.env.ACP_CODEX_ARGS).length ? splitArgs(process.env.ACP_CODEX_ARGS) : ['--yes', '@agentclientprotocol/codex-acp'],
        shell: win,
        env: { CODEX_CONFIG: JSON.stringify(codexConfig) },
      };
    },
    meta: genericMeta,
    mcp: true,
  },
  pi: {
    // NOT wired: pi-acp accepts mcpServers in session/new but does NOT hand them to
    // pi (pi has no native MCP; needs the community pi-mcp-adapter extension, which
    // reads .pi/mcp.json — not our session/new list). Passing them breaks some
    // builds (they reject non-empty mcpServers), so we skip them for pi.
    spawn: () => ({ command: process.env.ACP_PI_CMD ?? 'pi-acp', args: splitArgs(process.env.ACP_PI_ARGS), shell: win }),
    meta: genericMeta,
    mcp: false,
  },
  opencode: {
    // Ships its own ACP (`opencode acp`) and is MCP-native, so client MCP
    // servers in session/new should attach. BYO via standard provider env keys.
    spawn: () => ({ command: process.env.ACP_OPENCODE_CMD ?? 'opencode', args: splitArgs(process.env.ACP_OPENCODE_ARGS).length ? splitArgs(process.env.ACP_OPENCODE_ARGS) : ['acp'], shell: win }),
    meta: genericMeta,
    mcp: true,
  },
  qwen: {
    // Alibaba Qwen Code ships its own ACP (`qwen --acp`). BYO via provider env
    // key + optional --provider/--model flags.
    spawn: () => ({ command: process.env.ACP_QWEN_CMD ?? 'qwen', args: splitArgs(process.env.ACP_QWEN_ARGS).length ? splitArgs(process.env.ACP_QWEN_ARGS) : ['--acp'], shell: win }),
    meta: genericMeta,
    mcp: true,
  },
  kimi: {
    // Moonshot Kimi CLI (`kimi acp`). BYO via MOONSHOT_API_KEY.
    spawn: () => ({ command: process.env.ACP_KIMI_CMD ?? 'kimi', args: splitArgs(process.env.ACP_KIMI_ARGS).length ? splitArgs(process.env.ACP_KIMI_ARGS) : ['acp'], shell: win }),
    meta: genericMeta,
    mcp: true,
  },
  grok: {
    // xAI Grok Build (`grok agent stdio`). BYO via XAI_API_KEY.
    spawn: () => ({ command: process.env.ACP_GROK_CMD ?? 'grok', args: splitArgs(process.env.ACP_GROK_ARGS).length ? splitArgs(process.env.ACP_GROK_ARGS) : ['agent', 'stdio'], shell: win }),
    meta: genericMeta,
    mcp: true,
  },
};
function agentDef(id: string | undefined): AgentDef {
  return AGENTS[id ?? 'claude'] ?? AGENTS.claude!;
}

// ── In-app agent installer ───────────────────────────────────────────────────
// The picker's "Install" button runs these so the user never touches a terminal.
// Keyed by agent id; the command is what the agent's spawn needs on PATH.
const AGENT_INSTALL: Record<string, { cmd: string; args: string[]; shell?: boolean }> = {
  pi: { cmd: 'npm', args: ['install', '-g', 'pi-acp', '@earendil-works/pi-coding-agent'] },
  gemini: { cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'] },
  opencode: { cmd: 'npm', args: ['install', '-g', 'opencode-ai'] },
  qwen: { cmd: 'npm', args: ['install', '-g', '@qwen-code/qwen-code'] },
  kimi: { cmd: 'npm', args: ['install', '-g', '@moonshot-ai/kimi-code'] },
  grok: { cmd: 'bash', args: ['-c', 'curl -fsSL https://x.ai/cli/install.sh | bash'], shell: true },
};

/** Env override for an agent's launch command (if any). */
const AGENT_CMD_ENV: Record<string, string> = {
  gemini: 'ACP_GEMINI_CMD', codex: 'ACP_CODEX_CMD', pi: 'ACP_PI_CMD',
  opencode: 'ACP_OPENCODE_CMD', qwen: 'ACP_QWEN_CMD', kimi: 'ACP_KIMI_CMD', grok: 'ACP_GROK_CMD',
};

/** The binary that must be on PATH for an agent to run (claude is bundled). */
function agentCommand(id: string): string {
  const env = AGENT_CMD_ENV[id];
  if (env && process.env[env]) return process.env[env]!.trim().split(/\s+/)[0];
  switch (id) {
    case 'claude': return 'node'; // bundled adapter — always present
    case 'codex': return 'npx';   // codex-acp runs via npx, so nothing extra needed
    case 'gemini': return 'gemini';
    case 'pi': return 'pi-acp';
    case 'opencode': return 'opencode';
    case 'qwen': return 'qwen';
    case 'kimi': return 'kimi';
    case 'grok': return 'grok';
    default: return id;
  }
}

function commandExists(cmd: string): boolean {
  try {
    const check = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(check, [cmd], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// ── Bring-your-own-model ───────────────────────────────────────────────────
// Settings from the side panel (provider/model/key/baseUrl) are applied to the
// spawned agent: the API key is injected under the provider's standard env var,
// an optional base URL maps to the provider's base-url env var, and CLIs that
// take --provider/--model flags get them appended.
export interface ByoConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

const BYO_ENV_KEY: Record<string, string> = {
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

const BYO_BASE_URL_ENV: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  google: 'GEMINI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
};

/** Env injected into the agent process from a BYO config. */
function byoEnv(byo: ByoConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const p = (byo.provider ?? '').trim();
  if (byo.apiKey && p) {
    const key = BYO_ENV_KEY[p];
    if (key) env[key] = byo.apiKey.trim();
  }
  if (byo.baseUrl && p) {
    const base = BYO_BASE_URL_ENV[p];
    if (base) env[base] = byo.baseUrl.trim();
  }
  return env;
}

/** Extra CLI args for harnesses that accept --provider/--model (opencode, qwen). */
function byoArgs(agentId: string, byo: ByoConfig): string[] {
  if (!byo.enabled || !byo.provider) return [];
  const p = byo.provider.trim();
  const m = (byo.model ?? '').trim();
  // NOTE: pi-acp does NOT parse --provider/--model (only --terminal-login), so
  // Pi is deliberately excluded — its model is set inside pi itself (/model).
  if (agentId === 'opencode') {
    const args = [];
    if (m) args.push('--model', m); // opencode format: provider/model
    else args.push('--model', p);
    return args;
  }
  if (agentId === 'qwen' && (m || p)) {
    const args = ['--provider', p];
    if (m) args.push('--model', m);
    return args;
  }
  return [];
}

/** Wrap a spawn so BYO env/args are applied on top of the agent's defaults. */
function withByo(agentId: string, spawn: () => AgentSpawn, byo?: ByoConfig): () => AgentSpawn {
  if (!byo?.enabled) return spawn;
  return () => {
    const s = spawn();
    return {
      ...s,
      env: { ...s.env, ...byoEnv(byo) },
      args: [...s.args, ...byoArgs(agentId, byo)],
    };
  };
}

let extension: WebSocket | null = null;
/** id -> the client socket that issued the command (for response routing). */
const route = new Map<string, WebSocket>();

function onFatalPortError(label: string) {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[daemon] ${label} port in use — another daemon owns it; exiting.`);
      process.exit(0);
    }
    console.error(`[daemon] ${label} error:`, err.message);
  };
}

function pushToExtension(msg: unknown) {
  if (extension && extension.readyState === extension.OPEN) {
    extension.send(JSON.stringify(msg));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Chat manager — owns the ACP agent and per-session transcripts.
// ════════════════════════════════════════════════════════════════════════════
class ChatManager {
  private client: AcpClient | null = null;
  private starting: Promise<void> | null = null;
  private agentId = 'claude';
  /** The launch key of the current client (agent id + command + effort). */
  private clientKey: string | null = null;
  /** Bumped whenever the agent process changes; stale onExit/start callbacks
   *  check it so a killed process can't clobber the replacement's state. */
  private generation = 0;
  private store = new ChatStore();
  private skills = new SkillStore();
  /** the active agent's own commands/skills, advertised over ACP. */
  private agentCommands: unknown[] = [];
  /** sessions known to the *current* agent process (can be prompted). */
  private live = new Set<string>();
  /** accumulates streamed assistant text per session, flushed on turn end. */
  private buf = new Map<string, string>();

  /** The browser MCP handed to every agent session so it can drive the page. */
  private browserMcp(): McpServerSpec {
    return {
      name: 'browser',
      command: process.execPath, // node
      args: [INDEX_JS],
      env: [{ name: 'MCP_SESSION_LABEL', value: 'chat' }],
    };
  }

  private async ensureClient(key: string, id: string, def: AgentDef): Promise<AcpClient> {
    // Switching agent → tear down the old process and start the chosen one.
    if (this.client && this.clientKey !== key) {
      this.generation++;
      this.client.stop();
      this.client = null;
      this.starting = null;
      this.live.clear();
    }
    this.clientKey = key;
    this.agentId = id;
    if (this.client) return this.client;
    if (!this.starting) {
      const gen = ++this.generation;
      const client = new AcpClient(def.spawn(), {
        onUpdate: (sid, update) => this.onUpdate(sid, update),
        onPermission: (req) =>
          pushToExtension({
            type: 'acp/permissionRequest',
            sessionId: req.sessionId,
            requestId: req.requestId,
            toolCall: req.toolCall,
            options: req.options,
          }),
        onExit: (code) => {
          // Ignore exits from a process we already replaced.
          if (gen !== this.generation) return;
          console.error(`[daemon] agent exited (${code})`);
          this.client = null;
          this.starting = null;
          this.live.clear();
        },
        onLog: (line) => console.error('[agent]', line),
      });
      this.starting = client
        .start()
        .then(() => {
          if (gen === this.generation) this.client = client;
          console.error(`[daemon] ACP agent ready (${this.agentId})`);
        })
        .catch((e) => {
          if (gen === this.generation) this.starting = null;
          throw e;
        });
    }
    await this.starting;
    return this.client!;
  }

  private onUpdate(sessionId: string, update: Record<string, any>) {
    // Relay raw update to the side panel for live rendering.
    pushToExtension({ type: 'acp/update', sessionId, update });

    // Accumulate assistant text; persist tool calls as they happen.
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = update.content?.text ?? '';
      this.buf.set(sessionId, (this.buf.get(sessionId) ?? '') + text);
    } else if (kind === 'tool_call') {
      this.store.append(sessionId, {
        role: 'tool',
        text: `${update.title ?? 'tool'} (${update.kind ?? 'other'})`,
        ts: Date.now(),
      });
    } else if (kind === 'plan') {
      const entries = (update.entries ?? []).map((e: any) => `- ${e.content}`).join('\n');
      this.store.append(sessionId, { role: 'plan', text: entries, ts: Date.now() });
    } else if (kind === 'available_commands_update') {
      // The agent advertised its own commands/skills (pi/Claude/etc.).
      this.agentCommands = update.availableCommands ?? update.commands ?? [];
    }
  }

  listSkills() {
    pushToExtension({ type: 'acp/skills', skills: this.skills.list(), commands: this.agentCommands });
  }

  deleteSkill(id: string) {
    this.skills.delete(id);
    this.listSkills();
  }

  renameSkill(id: string, name: string) {
    this.skills.rename(id, name);
    this.listSkills();
  }

  private flushAssistant(sessionId: string) {
    const text = this.buf.get(sessionId);
    if (text && text.trim()) {
      this.store.append(sessionId, { role: 'assistant', text, ts: Date.now() });
    }
    this.buf.delete(sessionId);
  }

  async newSession(agentId?: string, cmd?: string, args?: string[], model?: string, effort?: 'low' | 'medium' | 'high', byo?: ByoConfig): Promise<string> {
    const id = agentId ?? 'claude';
    // A "custom" agent runs a command supplied by the side panel; everything
    // else comes from the built-in registry. Claude also honors a model choice.
    // BYO env/args are layered on top of whatever the agent's default spawn is.
    const def: AgentDef =
      id === 'custom' && cmd
        ? {
            spawn: withByo(id, () => ({ command: cmd, args: args ?? [], shell: win }), byo),
            meta: genericMeta,
            mcp: true,
          }
        : { ...agentDef(id), spawn: withByo(id, agentDef(id).spawn, byo) };
    const meta = id === 'claude' ? claudeMeta(model, effort) : def.meta();
    // Key the client by command + effort, so editing either respawns the agent.
    const base = id === 'custom' ? `custom:${cmd} ${(args ?? []).join(' ')}` : id;
    const key = `${base}:effort-${effort ?? 'medium'}`;
    const client = await this.ensureClient(key, id, def);
    const mcpServers = def.mcp ? [this.browserMcp()] : [];
    const sessionId = await client.newSession(process.cwd(), mcpServers, meta);
    this.store.create(sessionId, { agentId: id, model, effort, cmd, args });
    this.live.add(sessionId);
    pushToExtension({ type: 'acp/sessionCreated', sessionId });
    return sessionId;
  }

  /** Re-attach an existing chat session so the user can keep talking to it. */
  async resumeSession(sessionId: string, agentIdHint?: string, modelHint?: string, effortHint?: 'low' | 'medium' | 'high'): Promise<boolean> {
    if (!this.client || !this.live.has(sessionId)) {
      // The session belongs to a previous agent process — resume it with the
      // agent it was created with (persisted), falling back to the side panel's
      // current agent / model / effort.
      try {
        const sess = this.store.get(sessionId);
        const agentId = sess?.agentId ?? agentIdHint ?? (this.client ? this.agentId : 'claude');
        const effort = sess?.effort ?? effortHint ?? 'medium';
        const def: AgentDef =
          agentId === 'custom' && sess?.cmd
            ? { spawn: () => ({ command: sess.cmd!, args: sess.args ?? [], shell: win }), meta: genericMeta, mcp: true }
            : agentDef(agentId);
        const base = agentId === 'custom' ? `custom:${sess?.cmd ?? ''} ${(sess?.args ?? []).join(' ')}` : agentId;
        const key = `${base}:effort-${effort}`;
        const client = await this.ensureClient(key, agentId, def);
        await client.loadSession(sessionId, process.cwd(), def.mcp ? [this.browserMcp()] : []);
        this.live.add(sessionId);
        // Backfill launch info so future resumes pick the right agent.
        this.store.setMeta(sessionId, { agentId, model: sess?.model ?? modelHint, effort });
        if (!this.store.get(sessionId)) this.store.create(sessionId, { agentId });
        pushToExtension({ type: 'acp/sessionCreated', sessionId });
        return true;
      } catch (e) {
        pushToExtension({ type: 'acp/error', sessionId, message: `Could not resume chat: ${String((e as any)?.message ?? e)}` });
        return false;
      }
    }
    pushToExtension({ type: 'acp/sessionCreated', sessionId });
    return true;
  }

  async prompt(sessionId: string, text: string, content?: unknown[]): Promise<void> {
    if (!this.client || !this.live.has(sessionId)) {
      // The agent process was lost (e.g. the daemon restarted). Transparently
      // resume this session, then send the message — no need to start over.
      const ok = await this.resumeSession(sessionId);
      if (!ok) return; // resume already surfaced the error
    }
    const hasImage = Array.isArray(content) && content.some((b: any) => b?.type === 'image');
    this.store.append(sessionId, { role: 'user', text: text || (hasImage ? '[image]' : ''), ts: Date.now() });
    this.buf.set(sessionId, '');
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.prompt(sessionId, text, content);
      this.flushAssistant(sessionId);
      pushToExtension({ type: 'acp/turnEnd', sessionId, stopReason: res?.stopReason ?? 'end_turn' });
    } catch (e) {
      this.flushAssistant(sessionId);
      pushToExtension({ type: 'acp/error', sessionId, message: String((e as any)?.message ?? e) });
    }
  }

  /** Turn recorded steps into a skill by asking the agent to author it. */
  async skillFromRecording(sessionId: string, steps: unknown[]): Promise<void> {
    const prompt =
      'I just recorded these browser actions as JSON steps. Turn them into a reusable, ' +
      'parameterized skill: give it a short name, describe what it does, list any inputs ' +
      'that should be variables (e.g. search terms, form values), and write the ordered ' +
      'steps a future agent should follow (using the browser_* tools) to replay it.\n\n' +
      '```json\n' + JSON.stringify(steps, null, 2) + '\n```';
    await this.prompt(sessionId, prompt);
  }

  cancel(sessionId: string) {
    this.client?.cancel(sessionId);
  }

  respondPermission(requestId: number, optionId: string | null) {
    this.client?.respondPermission(requestId, optionId);
  }

  listSessions() {
    pushToExtension({ type: 'acp/sessions', sessions: this.store.list() });
  }

  /** Report which agent CLIs are installed so the picker can show Install buttons. */
  agentStatus() {
    const status = Object.keys(AGENTS).map((id) => {
      const installed = commandExists(agentCommand(id));
      // Pi needs BOTH the adapter and the pi binary to actually run.
      const missing: string[] = [];
      if (!commandExists(agentCommand(id))) missing.push(agentCommand(id));
      if (id === 'pi' && commandExists('pi-acp') && !commandExists('pi')) missing.push('pi');
      // Can we register the browser MCP into this harness from here?
      const spec = connectSpec(id);
      const connectable = !!spec && commandExists(spec[0]);
      return { id, installed: missing.length === 0, missing, connectable };
    });
    pushToExtension({ type: 'acp/agentStatus', status, mcpPath: INDEX_JS });
  }

  /** Run the agent's installer in-app, streaming output back to the picker. */
  installAgent(agentId: string) {
    const inst = AGENT_INSTALL[agentId];
    if (!inst) {
      pushToExtension({ type: 'acp/installDone', agentId, ok: false, error: 'No installer for this agent.' });
      return;
    }
    pushToExtension({ type: 'acp/installStarted', agentId, command: `${inst.cmd} ${inst.args.join(' ')}` });
    const child = spawn(inst.cmd, inst.args, { shell: inst.shell ?? false });
    const relay = (d: Buffer) => pushToExtension({ type: 'acp/installLog', agentId, line: d.toString() });
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (e) => pushToExtension({ type: 'acp/installDone', agentId, ok: false, error: String(e.message) }));
    child.on('close', (code) => {
      pushToExtension({ type: 'acp/installDone', agentId, ok: code === 0 });
      this.agentStatus();
    });
  }

  loadSession(sessionId: string) {
    const s = this.store.get(sessionId);
    pushToExtension({ type: 'acp/history', sessionId, messages: s?.messages ?? [] });
  }
}

const chat = new ChatManager();

// ── Register the browser MCP with other agents (one click, no copy-paste) ───
// Only harnesses with a non-interactive registration CLI are listed.
function connectSpec(agentId: string): [string, string[]] | null {
  switch (agentId) {
    case 'claude': return ['claude', ['mcp', 'add', 'pilot', '--scope', 'user', '--', 'node', INDEX_JS]];
    case 'codex': return ['codex', ['mcp', 'add', 'pilot', '--', 'node', INDEX_JS]];
    case 'gemini': return ['gemini', ['mcp', 'add', 'pilot', 'node', INDEX_JS]];
    case 'opencode': return ['opencode', ['mcp', 'add', 'pilot', '--', 'node', INDEX_JS]];
    default: return null;
  }
}

function connectAgent(agentId: string) {
  const spec = connectSpec(agentId);
  if (!spec) {
    pushToExtension({ type: 'acp/connectResult', agentId, ok: false, output: 'Unsupported agent.' });
    return;
  }
  const [cmd, args] = spec;
  pushToExtension({ type: 'acp/connectStarted', agentId });
  let out = '';
  let child;
  try {
    child = spawn(cmd, args, { shell: true });
  } catch (e) {
    pushToExtension({ type: 'acp/connectResult', agentId, ok: false, output: String((e as any)?.message ?? e) });
    return;
  }
  child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
  child.on('error', (e) =>
    pushToExtension({ type: 'acp/connectResult', agentId, ok: false, output: String(e.message) }),
  );
  child.on('close', (code) =>
    pushToExtension({ type: 'acp/connectResult', agentId, ok: code === 0, output: out.trim() }),
  );
}

async function handleAcpMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'acp/newSession':
        await chat.newSession(msg.agentId, msg.cmd, msg.args, msg.model, msg.effort, msg.byo);
        break;
      case 'acp/resumeSession': await chat.resumeSession(msg.sessionId, msg.agentId, msg.model, msg.effort); break;
      case 'acp/prompt': await chat.prompt(msg.sessionId, msg.text, msg.content); break;
      case 'acp/cancel': chat.cancel(msg.sessionId); break;
      case 'acp/permission': chat.respondPermission(msg.requestId, msg.optionId); break;
      case 'acp/log': console.error('[ext]', (msg as any).msg); break;
      case 'acp/listSessions': chat.listSessions(); break;
      case 'acp/listSkills': chat.listSkills(); break;
      case 'acp/deleteSkill': chat.deleteSkill(msg.id); break;
      case 'acp/renameSkill': chat.renameSkill(msg.id, msg.name); break;
      case 'acp/loadSession': chat.loadSession(msg.sessionId); break;
      case 'acp/agentStatus': chat.agentStatus(); break;
      case 'acp/connectAgent': connectAgent(msg.agentId); break;
      case 'acp/installAgent': chat.installAgent(msg.agentId); break;
      case 'acp/skillFromRecording': await chat.skillFromRecording(msg.sessionId, msg.steps); break;
      default: console.error('[daemon] unknown acp message:', msg.type);
    }
  } catch (e) {
    pushToExtension({ type: 'acp/error', message: String((e as any)?.message ?? e) });
  }
}

// ── Extension side (one connection) ───────────────────────────────────────
const extWss = new WebSocketServer({ port: EXT_PORT });
extWss.on('error', onFatalPortError('extension'));
extWss.on('listening', () =>
  console.error(`[daemon] extension bridge on ws://localhost:${EXT_PORT}`),
);
extWss.on('connection', (ws) => {
  console.error('[daemon] extension connected');
  extension = ws;
  // Keep the MV3 service worker alive: Chromium extends the SW lifetime on
  // WebSocket activity, so a steady ping stops the 30s idle death that was
  // dropping in-flight tool calls mid-turn.
  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20_000);
  ws.on('close', () => clearInterval(keepAlive));
  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Chat / ACP channel from the side panel.
    if (typeof msg.type === 'string' && msg.type.startsWith('acp/')) {
      void handleAcpMessage(msg);
      return;
    }
    // Otherwise: a reply to a browser command we forwarded — route back by id.
    const client = route.get(msg.id);
    if (client) {
      route.delete(msg.id);
      if (client.readyState === client.OPEN) client.send(data.toString());
    }
  });
  ws.on('close', () => {
    if (extension === ws) extension = null;
    console.error('[daemon] extension disconnected');
  });
});

// ── MCP client side (many connections) ────────────────────────────────────
const cliWss = new WebSocketServer({ port: CLIENT_PORT });
cliWss.on('error', onFatalPortError('client'));
cliWss.on('listening', () =>
  console.error(`[daemon] MCP clients on ws://localhost:${CLIENT_PORT}`),
);
cliWss.on('connection', (ws) => {
  console.error('[daemon] MCP client connected');
  ws.on('message', async (data) => {
    let msg: { id: string; method: string; params?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!extension || extension.readyState !== extension.OPEN) {
      // No browser connected — auto-launch one with the extension and wait.
      const ok = await ensureExtension();
      if (!ok || !extension || extension.readyState !== extension.OPEN) {
        ws.send(
          JSON.stringify({
            id: msg.id,
            ok: false,
            error:
              'Browser extension not connected. Tried to auto-launch a browser — make sure ' +
              'Chrome/Edge is installed and the extension is built ("npm run build").',
          }),
        );
        return;
      }
    }
    route.set(msg.id, ws);
    console.error(`[daemon] → ${msg.method} (${msg.id})`);
    extension.send(data.toString());
  });
  ws.on('close', () => {
    for (const [id, client] of route) if (client === ws) route.delete(id);
  });
});

console.error('[daemon] Browser Extension bridge daemon starting…');
