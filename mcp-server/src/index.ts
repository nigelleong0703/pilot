#!/usr/bin/env node
/**
 * My Recorder MCP server (thin client).
 *
 * Connects a local AI (over MCP/stdio) to the shared bridge DAEMON, which owns
 * the single connection to the browser extension. Decoupling the bridge from
 * the per-session server means many Claude sessions can coexist without
 * fighting over the extension's port — the daemon is the single broker.
 *
 *   AI --stdio--> this server --ws://9235--> daemon --ws://9234--> extension --> page
 *
 * If no daemon is running, the first server auto-spawns one (detached), so it
 * "just works" without any install. See bridge-daemon.ts.
 *
 * IMPORTANT: stdout is reserved for the MCP protocol. Logs go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { SkillStore } from './skill-store.js';

const CLIENT_PORT = Number(process.env.MCP_BRIDGE_CLIENT_PORT ?? 9235);
const DAEMON_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), 'bridge-daemon.js');

// Per-session identity → the extension gives each session its own tab + group.
// Set MCP_SESSION_LABEL in the server's registration to name the group
// (e.g. "work" / "social"), à la `claude --tab-group`.
const SESSION_ID = randomUUID();
const SESSION_LABEL = process.env.MCP_SESSION_LABEL || `s-${SESSION_ID.slice(0, 6)}`;

// ── Connection to the bridge daemon (with auto-spawn + reconnect) ──────────
let socket: WebSocket | null = null;
let daemonSpawned = false;
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

function spawnDaemon() {
  if (daemonSpawned) return;
  daemonSpawned = true;
  try {
    const child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.error('[mcp] spawned bridge daemon');
  } catch (e) {
    console.error('[mcp] failed to spawn daemon:', (e as Error).message);
  }
}

function connectDaemon() {
  const ws = new WebSocket(`ws://localhost:${CLIENT_PORT}`);
  socket = ws;
  ws.on('open', () => {
    daemonSpawned = false; // healthy; allow a future respawn if it dies
    console.error('[mcp] connected to bridge daemon');
  });
  ws.on('message', (data) => {
    let msg: { id: string; ok: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'Command failed'));
  });
  ws.on('error', () => {
    /* handled by 'close' */
  });
  ws.on('close', () => {
    if (socket === ws) socket = null;
    spawnDaemon(); // daemon not up (or died) — start one
    setTimeout(ensureConnection, 1500);
  });
}

function ensureConnection() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connectDaemon();
}

ensureConnection();

/** Send a command to the daemon (→ extension) and await its response.
 *  Generous default timeout: the first call may auto-launch a browser. */
function call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(
      new Error(
        'Bridge not ready yet. The daemon is starting — retry shortly, and make sure ' +
          'the browser with the "Browser Extension" extension is open.',
      ),
    );
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${method}"`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket!.send(
      JSON.stringify({ id, method, params, session: { id: SESSION_ID, label: SESSION_LABEL } }),
    );
  });
}

const asText = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// ── MCP server + tools ────────────────────────────────────────────────────
const server = new McpServer({ name: 'pilot', version: '1.0.0' });

// ── Skills (persist + auto-export to every installed agent) ─────────────────
const skills = new SkillStore();

server.registerTool(
  'save_skill',
  {
    title: 'Save skill',
    description:
      'Persist a reusable skill (e.g. from a recording or a completed task) and AUTO-EXPORT it ' +
      'to every AI agent installed on this machine (Claude Code, Codex, pi). Call this after you ' +
      'analyze recorded steps: give a short name, a one-line description, any inputs that should ' +
      'be variables, and the ordered steps (each using the browser_* tools) to replay it.',
    inputSchema: {
      name: z.string().describe('Short skill name'),
      description: z.string().optional().describe('One-line description'),
      inputs: z.array(z.string()).optional().describe('Names of values that should be variables'),
      steps: z.array(z.string()).describe('Ordered steps to replay, referencing browser_* tools'),
    },
  },
  async ({ name, description, inputs, steps }) => {
    const { skill, exportedTo } = skills.save({ name, description: description ?? '', inputs: inputs ?? [], steps });
    return asText({ saved: true, id: skill.id, name: skill.name, exportedTo });
  },
);

server.registerTool(
  'list_skills',
  {
    title: 'List skills',
    description: 'List reusable skills saved on this machine.',
    inputSchema: {},
  },
  async () =>
    asText({ skills: skills.list().map((s) => ({ id: s.id, name: s.name, description: s.description, inputs: s.inputs })) }),
);

server.registerTool(
  'browser_list_tabs',
  {
    title: 'List Pilot tabs',
    description:
      'Return the tabs in the Pilot group (the multi-tab workspace: the page Pilot is driving ' +
      'plus any tabs the user dragged in). Each entry has a "tabId" you can pass to the other ' +
      'browser_* tools to act on that specific tab. Use this to work across several tabs.',
    inputSchema: {},
  },
  async () => asText(await call('listTabs')),
);

server.registerTool(
  'browser_navigate',
  {
    title: 'Navigate',
    description: 'Navigate a browser tab to a URL (defaults to the active Pilot tab).',
    inputSchema: {
      url: z.string().url().describe('Absolute URL to open'),
      tabId: z.number().int().optional().describe('Tab to navigate (from browser_list_tabs)'),
    },
  },
  async ({ url, tabId }) => asText(await call('navigate', { url, tabId })),
);

server.registerTool(
  'browser_snapshot',
  {
    title: 'Snapshot page',
    description:
      'Return a list of visible interactive elements on a tab, each with a numeric "ref". ' +
      'Use a ref with browser_click / browser_type. Call this before interacting.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Tab to snapshot (defaults to active Pilot tab)'),
    },
  },
  async ({ tabId }) => asText(await call('snapshot', { tabId })),
);

server.registerTool(
  'browser_click',
  {
    title: 'Click element',
    description: 'Click an element by its snapshot ref (preferred) or a CSS selector.',
    inputSchema: {
      ref: z.number().int().optional().describe('ref from browser_snapshot'),
      selector: z.string().optional().describe('CSS selector (fallback)'),
      tabId: z.number().int().optional().describe('Tab to click in (defaults to active Pilot tab)'),
    },
  },
  async ({ ref, selector, tabId }) => asText(await call('click', { ref, selector, tabId })),
);

server.registerTool(
  'browser_type',
  {
    title: 'Type into element',
    description: 'Type text into an input/textarea by snapshot ref or CSS selector.',
    inputSchema: {
      ref: z.number().int().optional().describe('ref from browser_snapshot'),
      selector: z.string().optional().describe('CSS selector (fallback)'),
      text: z.string().describe('Text to type'),
      submit: z.boolean().optional().describe('Submit the form / press Enter after typing'),
      tabId: z.number().int().optional().describe('Tab to type in (defaults to active Pilot tab)'),
    },
  },
  async ({ ref, selector, text, submit, tabId }) =>
    asText(await call('type', { ref, selector, text, submit, tabId })),
);

server.registerTool(
  'browser_select_option',
  {
    title: 'Select dropdown option',
    description:
      'Select an option in a native <select> element by its visible text. ' +
      'Use this instead of browser_type for <select> dropdowns (e.g. Pre-Approval Type, country selects).',
    inputSchema: {
      ref: z.number().int().optional().describe('ref from browser_snapshot'),
      selector: z.string().optional().describe('CSS selector (fallback)'),
      text: z.string().describe('Visible option text to select (case-insensitive)'),
      tabId: z.number().int().optional().describe('Tab to select in (defaults to active Pilot tab)'),
    },
  },
  async ({ ref, selector, text, tabId }) => asText(await call('selectOption', { ref, selector, text, tabId })),
);

server.registerTool(
  'browser_get_text',
  {
    title: 'Get page text',
    description: 'Return the visible text content of a tab (truncated).',
    inputSchema: {
      tabId: z.number().int().optional().describe('Tab to read (defaults to active Pilot tab)'),
    },
  },
  async ({ tabId }) => asText(await call('getText', { tabId })),
);

server.registerTool(
  'browser_screenshot',
  {
    title: 'Screenshot',
    description: 'Capture a JPEG screenshot of a tab viewport.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Tab to capture (defaults to active Pilot tab)'),
    },
  },
  async ({ tabId }) => {
    const { dataUrl } = (await call('screenshot', { tabId })) as { dataUrl: string };
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    return { content: [{ type: 'image' as const, data: base64, mimeType: 'image/jpeg' }] };
  },
);

server.registerTool(
  'recorder_start',
  {
    title: 'Start recording',
    description:
      'Begin recording user actions (clears any previous recording). ' +
      'Optionally pass a message to display in the side panel so the user knows what to do.',
    inputSchema: {
      message: z.string().optional().describe(
        'Guidance shown to the user in the side panel, e.g. "Go to the site and perform the steps you want to teach me, then press Stop."',
      ),
    },
  },
  async ({ message }) => asText(await call('recorder.start', message ? { message } : {})),
);

server.registerTool(
  'recorder_stop',
  {
    title: 'Stop recording',
    description: 'Stop recording user actions.',
    inputSchema: {},
  },
  async () => asText(await call('recorder.stop')),
);

server.registerTool(
  'recorder_get_steps',
  {
    title: 'Get recorded steps',
    description:
      'Return the recorded steps (type, semantic label, value, selector, url). ' +
      'Use this to turn a recording into a reusable skill. Screenshots are omitted to keep the payload small.',
    inputSchema: {},
  },
  async () => {
    const data = (await call('recorder.getSteps')) as {
      isRecording: boolean;
      steps: Array<Record<string, unknown>>;
    };
    const steps = data.steps.map(({ screenshot, ...rest }) => ({
      ...rest,
      hasScreenshot: Boolean(screenshot),
    }));
    return asText({ isRecording: data.isRecording, count: steps.length, steps });
  },
);

server.registerTool(
  'recorder_wait_for_stop',
  {
    title: 'Wait for recording to stop',
    description:
      'Polls the recorder every 3 seconds until the user presses Stop (up to 5 minutes). ' +
      'Returns the recorded steps when done. ' +
      'Use this for AI-driven "teach me a skill" workflows: call recorder_start with a guidance message, ' +
      'then call this tool — it blocks until the user finishes recording and returns all steps.',
    inputSchema: {},
  },
  async () => {
    const MAX_POLLS = 100; // 100 × 3 s = 5 minutes
    for (let i = 0; i < MAX_POLLS; i++) {
      const data = (await call('recorder.getSteps')) as {
        isRecording: boolean;
        steps: Array<Record<string, unknown>>;
      };
      if (!data.isRecording) {
        const steps = data.steps.map(({ screenshot, ...rest }) => ({
          ...rest,
          hasScreenshot: Boolean(screenshot),
        }));
        return asText({ stopped: true, count: steps.length, steps });
      }
      await new Promise<void>((r) => setTimeout(r, 3000));
    }
    throw new Error('Timed out waiting for recording to stop (5 minutes elapsed)');
  },
);

// ── Boot ───────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] my-recorder MCP server ready on stdio');
}

main().catch((err) => {
  console.error('[mcp] fatal:', err);
  process.exit(1);
});
