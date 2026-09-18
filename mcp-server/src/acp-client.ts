/**
 * ACP (Agent Client Protocol) client.
 *
 * Spawns an ACP agent (e.g. `claude-code-acp`) as a subprocess and speaks
 * JSON-RPC 2.0 over newline-delimited stdio — the transport confirmed against
 * @zed-industries/claude-code-acp v0.16.2.
 *
 *   broker (this) --ndjson stdio--> claude-code-acp --> Claude
 *
 * The client is the "front end": it drives the agent (initialize, session/new,
 * session/prompt) and handles the agent's callbacks (permission prompts,
 * filesystem reads/writes). Streaming `session/update` notifications and
 * permission requests are surfaced through the callbacks passed to the ctor so
 * the daemon can relay them to the browser side panel.
 *
 * See https://agentclientprotocol.com for the protocol.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface AcpUpdate {
  sessionUpdate: string;
  [k: string]: unknown;
}

export interface PermissionRequest {
  requestId: number;
  sessionId: string;
  toolCall: unknown;
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export interface AcpClientCallbacks {
  /** Streaming session/update for a session (message chunks, tool calls, plans). */
  onUpdate?: (sessionId: string, update: AcpUpdate) => void;
  /** Agent is asking the user to approve a tool call. Resolve via respondPermission(). */
  onPermission?: (req: PermissionRequest) => void;
  /** Agent process died. */
  onExit?: (code: number | null) => void;
  /** Free-form log line (agent stderr). */
  onLog?: (line: string) => void;
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

/** How to launch the agent subprocess. */
export interface AgentSpawn {
  command: string;
  args: string[];
  /** Use a shell (needed for a Windows `.cmd` shim; false when running node directly). */
  shell?: boolean;
  /** Extra environment variables applied to this agent's process (e.g. CODEX_CONFIG). */
  env?: Record<string, string>;
}

/**
 * Locate git-bash.exe, which claude-code-acp requires on Windows. Honors an
 * explicit CLAUDE_CODE_GIT_BASH_PATH; otherwise probes the usual install spots.
 */
function findGitBash(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const explicit = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.USERPROFILE ?? '';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${home}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`,
  ];
  return candidates.find((p) => existsSync(p));
}

export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private cb: AcpClientCallbacks;
  private spawnSpec: AgentSpawn;

  constructor(spawnSpec: AgentSpawn, cb: AcpClientCallbacks = {}) {
    super();
    this.spawnSpec = spawnSpec;
    this.cb = cb;
  }

  /** Spawn the agent and perform the initialize handshake. */
  async start(): Promise<any> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // A nested Claude Code refuses to launch — the broker is standalone, but be safe.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    const bash = findGitBash();
    if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
    // Optional isolation: a dedicated config dir means ONLY the browser MCP we
    // inject is available (the user's global MCP servers don't leak in). Requires
    // a one-time `claude /login` with CLAUDE_CONFIG_DIR set to this same path.
    if (process.env.ACP_CLAUDE_CONFIG_DIR) {
      env.CLAUDE_CONFIG_DIR = process.env.ACP_CLAUDE_CONFIG_DIR;
    }

    const child = spawn(this.spawnSpec.command, this.spawnSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.spawnSpec.shell ?? false,
      env: { ...env, ...(this.spawnSpec.env ?? {}) },
    });
    this.child = child;

    child.stdout.on('data', (d: Buffer) => this.onData(d.toString()));
    child.stderr.on('data', (d: Buffer) => this.cb.onLog?.(d.toString().trimEnd()));
    child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error('agent exited'));
      this.pending.clear();
      this.cb.onExit?.(code);
    });

    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'browser-extension-broker', version: '1.0.0' },
    });
  }

  /**
   * Start a new agent session, wiring in the browser MCP server as a tool source.
   * `meta` maps to claude-code-acp's `_meta` (systemPrompt, claudeCode.options…),
   * which we use to steer tool choice and avoid loading the user's other MCP servers.
   */
  async newSession(cwd: string, mcpServers: McpServerSpec[], meta?: unknown): Promise<string> {
    const params: Record<string, unknown> = { cwd, mcpServers };
    if (meta) params._meta = meta;
    const res = await this.request('session/new', params);
    return res.sessionId as string;
  }

  /** Resume a previously created session (agent capability loadSession). */
  async loadSession(sessionId: string, cwd: string, mcpServers: McpServerSpec[]): Promise<void> {
    await this.request('session/load', { sessionId, cwd, mcpServers });
  }

  /**
   * Send a user turn. Resolves with { stopReason } when the turn completes.
   * `content` (ACP ContentBlock[]) is used when present (e.g. text + image);
   * otherwise a single text block is sent.
   */
  async prompt(sessionId: string, text: string, content?: unknown[]): Promise<any> {
    const prompt = Array.isArray(content) && content.length ? content : [{ type: 'text', text }];
    return this.request('session/prompt', { sessionId, prompt });
  }

  /** Interrupt the current turn. */
  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  /** Answer a pending session/request_permission. */
  respondPermission(requestId: number, optionId: string | null): void {
    const outcome = optionId
      ? { outcome: 'selected', optionId }
      : { outcome: 'cancelled' };
    this.send({ jsonrpc: '2.0', id: requestId, result: { outcome } });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  // ── JSON-RPC plumbing ────────────────────────────────────────────────────
  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.cb.onLog?.(`[unparsed] ${line}`);
      return;
    }

    // Response to a request we made.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      }
      return;
    }

    // Request or notification FROM the agent.
    if (msg.method) this.handleAgentMessage(msg);
  }

  private handleAgentMessage(msg: any) {
    const { method, params, id } = msg;
    switch (method) {
      case 'session/update':
        this.cb.onUpdate?.(params.sessionId, params.update);
        return;

      case 'session/request_permission':
        // Surface to the UI; the daemon calls respondPermission(id, optionId).
        this.cb.onPermission?.({
          requestId: id,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options ?? [],
        });
        return;

      case 'fs/read_text_file': {
        try {
          const text = readFileSync(params.path, 'utf8');
          this.send({ jsonrpc: '2.0', id, result: { content: text } });
        } catch (e) {
          this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e) } });
        }
        return;
      }

      case 'fs/write_text_file': {
        try {
          writeFileSync(params.path, params.content ?? '', 'utf8');
          this.send({ jsonrpc: '2.0', id, result: {} });
        } catch (e) {
          this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e) } });
        }
        return;
      }

      default:
        // Unknown agent request — ack so the turn doesn't hang.
        if (id !== undefined) this.send({ jsonrpc: '2.0', id, result: {} });
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(obj: unknown) {
    if (!this.child) throw new Error('agent not started');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }
}
