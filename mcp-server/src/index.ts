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
      actions: z.array(z.any()).optional().describe('Deterministic replay actions (from a recording) — enables browser_run_skill'),
    },
  },
  async ({ name, description, inputs, steps, actions }) => {
    const { skill, exportedTo } = skills.save({ name, description: description ?? '', inputs: inputs ?? [], steps, actions });
    return asText({ saved: true, id: skill.id, name: skill.name, exportedTo });
  },
);

server.registerTool(
  'browser_run_skill',
  {
    title: 'Run a saved skill',
    description:
      'Replay a saved skill DETERMINISTICALLY in one call (no step-by-step browser_* tool calls). ' +
      'Looks the skill up by name and runs its recorded actions; optional `inputs` substitute ' +
      '{{name}} placeholders in those actions.',
    inputSchema: {
      name: z.string().describe('Skill name (or id) from list_skills'),
      inputs: z.record(z.any()).optional().describe('Values for the skill inputs, e.g. { url: "..." }'),
      from: z.number().int().optional().describe('Action index to resume from (after handling a LIVE step)'),
    },
  },
  async ({ name, inputs, from }) => {
    const skill = skills.list().find((s) => s.name === name || s.id === name);
    if (!skill) throw new Error(`No skill named "${name}". Use list_skills.`);
    const actions = (skill.actions ?? []) as Array<Record<string, unknown>>;
    if (!actions.length) {
      throw new Error(`Skill "${name}" has no deterministic actions — replay it with the browser_* tools instead.`);
    }
    const values = (inputs ?? {}) as Record<string, unknown>;
    const subst = (v: unknown): unknown =>
      typeof v === 'string'
        ? v.replace(/\{\{\s*([a-z0-9_ -]+)\s*\}\}/gi, (_, k: string) => String(values[k.trim()] ?? `{{${k}}}`))
        : v;
    const resolved = actions.map((a) =>
      Object.fromEntries(Object.entries(a).map(([k, v]) => [k, subst(v)])),
    );

    // Steps flagged `live` depend on runtime state: run the fixed prefix, then
    // hand the live step back to the model instead of replaying it blindly.
    const start = Math.max(0, from ?? 0);
    let liveIdx = -1;
    for (let i = start; i < resolved.length; i++) if ((resolved[i] as any).live) { liveIdx = i; break; }
    const end = liveIdx === -1 ? resolved.length : liveIdx;
    const slice = resolved.slice(start, end);
    const ran = slice.length ? await call('replay', { actions: slice }, 180_000) : { results: [] };

    if (liveIdx !== -1) {
      const step = resolved[liveIdx] as any;
      return asText({
        ran,
        pausedAt: liveIdx,
        liveStep: { do: step.do ?? `${step.act} ${step.el ?? step.sel ?? ''}`, why: step.why },
        next: `This step depends on live page state. Do it now with browser_snapshot + browser_* (e.g. ${step.act} "${step.el ?? ''}"), then call browser_run_skill again with from=${liveIdx + 1}.`,
      });
    }
    return asText(ran);
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
    asText({ skills: skills.list().map((s) => ({ id: s.id, name: s.name, description: s.description, inputs: s.inputs, version: s.version, deterministic: !!(s.actions && s.actions.length) })) }),
);

server.registerTool(
  'get_skill',
  {
    title: 'Get a skill',
    description:
      'Read a saved skill in full: steps, inputs, version/changelog, and its deterministic ' +
      'actions (each with `why` intent and `live` flag). Use this before following or updating it.',
    inputSchema: { name: z.string().describe('Skill name (or id)') },
  },
  async ({ name }) => {
    const s = skills.find(name);
    if (!s) throw new Error(`No skill named "${name}". Use list_skills.`);
    return asText(s);
  },
);

server.registerTool(
  'update_skill',
  {
    title: 'Update a skill (global)',
    description:
      'Refine a saved skill and re-export it to EVERY installed agent (Claude Code, Codex, pi). ' +
      'Use this when a skill failed or needs a tweak: pass the changed fields plus a short `note`. ' +
      'Bumps the version (old revisions are archived). Pass `steps` (and optional `actions` with ' +
      'why/live) to replace the flow. Only update when needed — once it works reliably, leave it.',
    inputSchema: {
      name: z.string().describe('Skill name (or id)'),
      description: z.string().optional(),
      inputs: z.array(z.string()).optional(),
      steps: z.array(z.string()).optional().describe('Replacement step list'),
      actions: z.array(z.any()).optional().describe('Replacement deterministic actions (act/sel/el/value/why/live)'),
      note: z.string().optional().describe('Why it changed (recorded in the changelog)'),
    },
  },
  async ({ name, description, inputs, steps, actions, note }) => {
    const s = skills.find(name);
    if (!s) throw new Error(`No skill named "${name}". Use list_skills.`);
    const { skill, exportedTo } = skills.save({
      id: s.id,
      name: s.name,
      description: description ?? s.description,
      inputs: inputs ?? s.inputs,
      steps: steps ?? s.steps,
      actions: actions ?? s.actions,
      note: note ?? 'updated',
      source: process.env.MCP_SESSION_LABEL || 'mcp',
    });
    return asText({ updated: true, id: skill.id, name: skill.name, version: skill.version, exportedTo });
  },
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
  'browser_new_tab',
  {
    title: 'Open a new tab',
    description:
      'Open a URL in a NEW tab inside the Pilot group (returns tabId). Use this ONLY when the task ' +
      'genuinely needs an extra page open in parallel — for normal navigation/clicks, reuse the ' +
      'existing workspace tab instead. Never overwrite the tab the user is actively using.',
    inputSchema: {
      url: z.string().describe('Absolute URL to open (or "" for a blank tab)').optional(),
    },
  },
  async ({ url }) => asText(await call('newTab', { url })),
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
    description: 'Click an element by its snapshot ref (preferred), a CSS selector, or visible `text` (searches every frame, including cross-origin iframes).',
    inputSchema: {
      ref: z.number().int().optional().describe('ref from browser_snapshot'),
      selector: z.string().optional().describe('CSS selector (fallback)'),
      text: z.string().optional().describe('Visible text / aria-label to match (works across all frames)'),
      tabId: z.number().int().optional().describe('Tab to click in (defaults to active Pilot tab)'),
    },
  },
  async ({ ref, selector, text, tabId }) => asText(await call('click', { ref, selector, text, tabId })),
);

server.registerTool(
  'browser_type',
  {
    title: 'Type into element',
    description: 'Type text into an input/textarea by snapshot ref, CSS selector, or field label `match` (searches every frame, including cross-origin iframes).',
    inputSchema: {
      ref: z.number().int().optional().describe('ref from browser_snapshot'),
      selector: z.string().optional().describe('CSS selector (fallback)'),
      match: z.string().optional().describe('Field label / aria-label / placeholder to find the input (all frames)'),
      text: z.string().describe('Text to type'),
      submit: z.boolean().optional().describe('Submit the form / press Enter after typing'),
      tabId: z.number().int().optional().describe('Tab to type in (defaults to active Pilot tab)'),
    },
  },
  async ({ ref, selector, match, text, submit, tabId }) =>
    asText(await call('type', { ref, selector, match, text, submit, tabId })),
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
    description:
      'Capture a screenshot of a tab viewport. Set `grid:true` to overlay a labelled ' +
      '100px coordinate grid — use it to read pixel coordinates for browser_click_at.',
    inputSchema: {
      grid: z.boolean().optional().describe('Overlay a coordinate grid (labelled every 100px)'),
      tabId: z.number().int().optional().describe('Tab to capture (defaults to active Pilot tab)'),
    },
  },
  async ({ grid, tabId }) => {
    const { dataUrl } = (await call('screenshot', { grid, tabId })) as { dataUrl: string };
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(dataUrl) ?? [];
    const mime = m[1] ?? 'image/png';
    const base64 = m[2] ?? dataUrl;
    return { content: [{ type: 'image' as const, data: base64, mimeType: mime }] };
  },
);

server.registerTool(
  'browser_click_at',
  {
    title: 'Click at coordinates',
    description:
      'Click at a viewport pixel coordinate (x,y). Vision/coordinate fallback for pages where ' +
      'the DOM/a11y/a snapshot can\'t identify the element (canvas, complex SPAs, cross-origin UI). ' +
      'Take a screenshot with `grid:true` first to read the coordinates.',
    inputSchema: {
      x: z.number().describe('X in CSS pixels from the viewport top-left'),
      y: z.number().describe('Y in CSS pixels from the viewport top-left'),
      tabId: z.number().int().optional(),
    },
  },
  async ({ x, y, tabId }) => asText(await call('clickAt', { x, y, tabId })),
);

server.registerTool(
  'browser_key',
  {
    title: 'Press a key',
    description: 'Press a keyboard key on the focused element (Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp/PageDown, Home, End, Backspace, Space…).',
    inputSchema: {
      key: z.string().describe('Key name, e.g. "Enter", "Tab", "Escape", "ArrowDown"'),
      tabId: z.number().int().optional(),
    },
  },
  async ({ key, tabId }) => asText(await call('key', { key, tabId })),
);

server.registerTool(
  'browser_type_text',
  {
    title: 'Type into focused element',
    description: 'Insert text into whatever element is currently focused (pair with browser_click_at for coordinate flows). Optional `submit` presses Enter.',
    inputSchema: {
      text: z.string(),
      submit: z.boolean().optional(),
      tabId: z.number().int().optional(),
    },
  },
  async ({ text, submit, tabId }) => asText(await call('typeText', { text, submit, tabId })),
);

server.registerTool(
  'browser_scroll',
  {
    title: 'Scroll',
    description: 'Scroll the page with a mouse wheel at (x,y) (default 200,300). Positive dy scrolls down.',
    inputSchema: {
      dy: z.number().describe('Vertical delta in pixels (positive = down)'),
      dx: z.number().optional().describe('Horizontal delta in pixels'),
      x: z.number().optional().describe('Wheel X in viewport pixels'),
      y: z.number().optional().describe('Wheel Y in viewport pixels'),
      tabId: z.number().int().optional(),
    },
  },
  async ({ dy, dx, x, y, tabId }) => asText(await call('scroll', { dy, dx, x, y, tabId })),
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
