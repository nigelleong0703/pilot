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
import { createWriteStream, mkdirSync } from 'node:fs';
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

/** Claude honors _meta.systemPrompt + _meta.claudeCode.options (tool isolation + model). */
function claudeMeta(model?: string) {
  const options: Record<string, unknown> = { allowedTools: ['mcp__browser'] };
  if (model) options.model = model; // Claude Agent SDK model alias (opus/sonnet/haiku)
  return { systemPrompt: PILOT_SYSTEM_PROMPT, claudeCode: { options } };
}
/** Other ACP agents: steer via systemPrompt only (claudeCode options are ignored). */
function genericMeta() {
  return { systemPrompt: PILOT_SYSTEM_PROMPT };
}

const PILOT_SYSTEM_PROMPT =
  'You are Pilot. You control the user\'s CURRENT browser tab through the "browser" MCP ' +
  'server (browser_navigate, browser_snapshot, browser_click, browser_type, ' +
  'browser_select_option, browser_get_text, browser_screenshot). Every message includes the ' +
  'page the user is currently viewing. ALWAYS use these browser_* tools for any web browsing ' +
  'or page interaction — never launch a separate or headless browser. Typical flow: ' +
  'browser_snapshot -> browser_click/browser_type; browser_get_text to read the page. You can ' +
  'also record the user\'s actions and author skills via the recorder_* tools.';

interface AgentDef { spawn: () => AgentSpawn; meta: () => unknown; }
const AGENTS: Record<string, AgentDef> = {
  claude: { spawn: claudeSpawn, meta: claudeMeta },
  gemini: {
    spawn: () => ({ command: process.env.ACP_GEMINI_CMD ?? 'gemini', args: splitArgs(process.env.ACP_GEMINI_ARGS) .length ? splitArgs(process.env.ACP_GEMINI_ARGS) : ['--experimental-acp'], shell: win }),
    meta: genericMeta,
  },
  codex: {
    spawn: () => ({ command: process.env.ACP_CODEX_CMD ?? 'codex-acp', args: splitArgs(process.env.ACP_CODEX_ARGS), shell: win }),
    meta: genericMeta,
  },
  pi: {
    spawn: () => ({ command: process.env.ACP_PI_CMD ?? 'pi-acp', args: splitArgs(process.env.ACP_PI_ARGS), shell: win }),
    meta: genericMeta,
  },
};
function agentDef(id: string | undefined): AgentDef {
  return AGENTS[id ?? 'claude'] ?? AGENTS.claude!;
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

  private async ensureClient(agentId: string, def: AgentDef): Promise<AcpClient> {
    // Switching agent → tear down the old process and start the chosen one.
    if (this.client && this.agentId !== agentId) {
      this.client.stop();
      this.client = null;
      this.starting = null;
      this.live.clear();
    }
    this.agentId = agentId;
    if (this.client) return this.client;
    if (!this.starting) {
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
          this.client = client;
          console.error(`[daemon] ACP agent ready (${this.agentId})`);
        })
        .catch((e) => {
          this.starting = null;
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

  private flushAssistant(sessionId: string) {
    const text = this.buf.get(sessionId);
    if (text && text.trim()) {
      this.store.append(sessionId, { role: 'assistant', text, ts: Date.now() });
    }
    this.buf.delete(sessionId);
  }

  async newSession(agentId?: string, cmd?: string, args?: string[], model?: string, thinking?: boolean): Promise<string> {
    const id = agentId ?? 'claude';
    // Thinking is enabled per agent PROCESS via env (read at spawn). Set it here
    // and fold it into the client key so toggling it forces a respawn.
    if (thinking) process.env.MAX_THINKING_TOKENS = process.env.ACP_THINKING_TOKENS || '4000';
    else delete process.env.MAX_THINKING_TOKENS;
    // A "custom" agent runs a command supplied by the side panel; everything
    // else comes from the built-in registry. Claude also honors a model choice.
    const def: AgentDef =
      id === 'custom' && cmd
        ? { spawn: () => ({ command: cmd, args: args ?? [], shell: win }), meta: genericMeta }
        : agentDef(id);
    const meta = id === 'claude' ? claudeMeta(model) : def.meta();
    // Key the client by command + thinking, so editing either respawns the agent.
    const base = id === 'custom' ? `custom:${cmd} ${(args ?? []).join(' ')}` : id;
    const key = base + (thinking ? ':think' : '');
    const client = await this.ensureClient(key, def);
    const sessionId = await client.newSession(process.cwd(), [this.browserMcp()], meta);
    this.store.create(sessionId);
    this.live.add(sessionId);
    pushToExtension({ type: 'acp/sessionCreated', sessionId });
    return sessionId;
  }

  async prompt(sessionId: string, text: string, content?: unknown[]): Promise<void> {
    if (!this.client || !this.live.has(sessionId)) {
      pushToExtension({
        type: 'acp/error',
        sessionId,
        message: 'This chat is not active in the current agent process. Start a new chat to continue.',
      });
      return;
    }
    const hasImage = Array.isArray(content) && content.some((b: any) => b?.type === 'image');
    this.store.append(sessionId, { role: 'user', text: text || (hasImage ? '[image]' : ''), ts: Date.now() });
    this.buf.set(sessionId, '');
    try {
      const res = await this.client.prompt(sessionId, text, content);
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

  loadSession(sessionId: string) {
    const s = this.store.get(sessionId);
    pushToExtension({ type: 'acp/history', sessionId, messages: s?.messages ?? [] });
  }
}

const chat = new ChatManager();

async function handleAcpMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'acp/newSession':
        await chat.newSession(msg.agentId, msg.cmd, msg.args, msg.model, msg.thinking);
        break;
      case 'acp/prompt': await chat.prompt(msg.sessionId, msg.text, msg.content); break;
      case 'acp/cancel': chat.cancel(msg.sessionId); break;
      case 'acp/permission': chat.respondPermission(msg.requestId, msg.optionId); break;
      case 'acp/log': console.error('[ext]', (msg as any).msg); break;
      case 'acp/listSessions': chat.listSessions(); break;
      case 'acp/listSkills': chat.listSkills(); break;
      case 'acp/loadSession': chat.loadSession(msg.sessionId); break;
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
  ws.on('message', (data) => {
    let msg: { id: string; method: string; params?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!extension || extension.readyState !== extension.OPEN) {
      ws.send(
        JSON.stringify({
          id: msg.id,
          ok: false,
          error:
            'Browser extension not connected. Open Edge with the "Browser Extension" extension loaded.',
        }),
      );
      return;
    }
    route.set(msg.id, ws);
    extension.send(data.toString());
  });
  ws.on('close', () => {
    for (const [id, client] of route) if (client === ws) route.delete(id);
  });
});

console.error('[daemon] Browser Extension bridge daemon starting…');
