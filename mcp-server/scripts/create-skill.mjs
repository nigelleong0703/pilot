#!/usr/bin/env node
/**
 * Skill Creator
 *
 * Reads a recording JSON produced by the Browser Extension recorder and
 * outputs two files in the same directory:
 *
 *   <skill-name>.md  — instructions for Claude (how to invoke the skill)
 *   <skill-name>.js  — runnable Node.js script that replays the steps
 *
 * Usage:
 *   node create-skill.mjs <recording.json> [skill-name]
 *
 * Example:
 *   node create-skill.mjs recording-3-steps.json odoo-checkin
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────────────────────
const [, , recordingPath, rawName] = process.argv;
if (!recordingPath) {
  console.error('Usage: node create-skill.mjs <recording.json> [skill-name]');
  process.exit(1);
}

const absPath = resolve(recordingPath);
const steps = JSON.parse(readFileSync(absPath, 'utf8'));

// Derive skill name from filename or argument
const skillName = rawName
  ? rawName.replace(/\s+/g, '-').toLowerCase()
  : basename(absPath, '.json').replace(/^recording-?\d*-?steps?-?/i, '').replace(/\s+/g, '-').toLowerCase() || 'skill';

const outDir = dirname(absPath);

// ── Step analysis ─────────────────────────────────────────────────────────────
function describeStep(step) {
  switch (step.type) {
    case 'navigate':
      return `Navigate to ${step.url}`;
    case 'click':
      return `Click "${step.label || step.selector}" on ${new URL(step.url).pathname}`;
    case 'input':
    case 'change':
      return `Type "${step.value}" into "${step.label || step.selector}"`;
    case 'submit':
      return `Submit form via "${step.label || step.selector}"`;
    default:
      return `${step.type} — ${step.label || step.selector}`;
  }
}

function mcpToolCall(step) {
  switch (step.type) {
    case 'navigate':
      return { tool: 'browser_navigate', params: { url: step.url } };
    case 'click':
      return { tool: 'browser_click', params: { selector: step.selector } };
    case 'input':
    case 'change':
      return { tool: 'browser_type', params: { selector: step.selector, text: step.value } };
    case 'submit':
      return { tool: 'browser_click', params: { selector: step.selector } };
    default:
      return null;
  }
}

// Infer a human-readable skill title from the steps
function inferTitle(steps) {
  const urls = [...new Set(steps.map(s => {
    try { return new URL(s.url).hostname; } catch { return ''; }
  }).filter(Boolean))];
  const actions = steps.filter(s => s.type !== 'navigate').map(s => s.label).filter(Boolean);
  const site = urls[0] || 'web';
  const lastAction = actions[actions.length - 1] || '';
  return `${site} — ${lastAction || skillName}`;
}

const title = inferTitle(steps);
const toolCalls = steps.map(mcpToolCall).filter(Boolean);

// ── Generate skill.md ─────────────────────────────────────────────────────────
const mdLines = [
  `# Skill: ${skillName}`,
  ``,
  `## What it does`,
  `${title}`,
  ``,
  `## How to invoke`,
  `Say: *"${skillName.replace(/-/g, ' ')}"* or describe the goal in natural language.`,
  ``,
  `## Steps`,
  ...steps.map((step, i) => {
    const call = mcpToolCall(step);
    if (!call) return `${i + 1}. [skip] ${describeStep(step)}`;
    const paramsStr = Object.entries(call.params)
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');
    return `${i + 1}. \`${call.tool}(${paramsStr})\` — ${describeStep(step)}`;
  }),
  ``,
  `## MCP tool calls (copy-paste ready)`,
  `\`\`\``,
  ...toolCalls.map(c => {
    const p = Object.entries(c.params).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n');
    return `${c.tool}:\n${p}`;
  }),
  `\`\`\``,
  ``,
  `## Recorded steps (source)`,
  `| # | Type | Label | Selector | URL |`,
  `|---|------|-------|----------|-----|`,
  ...steps.map(s =>
    `| ${s.id} | ${s.type} | ${(s.label || '').slice(0, 40)} | \`${(s.selector || '').slice(0, 50)}\` | ${s.url.slice(0, 60)} |`
  ),
  ``,
  `_Generated from \`${basename(absPath)}\` — ${steps.length} steps recorded_`,
];

// ── Generate skill.js ─────────────────────────────────────────────────────────
const jsLines = [
  `#!/usr/bin/env node`,
  `/**`,
  ` * Skill: ${skillName}`,
  ` * ${title}`,
  ` *`,
  ` * Auto-generated from ${basename(absPath)}`,
  ` * Requires the Browser Extension daemon to be running (port 9235).`,
  ` *`,
  ` * Usage: node ${skillName}.js`,
  ` */`,
  `import { WebSocket } from 'ws';`,
  `import { randomUUID } from 'node:crypto';`,
  ``,
  `const CLIENT_PORT = Number(process.env.MCP_BRIDGE_CLIENT_PORT ?? 9235);`,
  `const SESSION_ID  = randomUUID();`,
  `const SESSION_LABEL = '${skillName}';`,
  ``,
  `function connect() {`,
  `  return new Promise((resolve, reject) => {`,
  `    const ws = new WebSocket(\`ws://localhost:\${CLIENT_PORT}\`);`,
  `    ws.on('open', () => resolve(ws));`,
  `    ws.on('error', reject);`,
  `    setTimeout(() => reject(new Error('Daemon not reachable on port ' + CLIENT_PORT)), 5000);`,
  `  });`,
  `}`,
  ``,
  `function call(ws, method, params = {}) {`,
  `  return new Promise((resolve, reject) => {`,
  `    const id = randomUUID();`,
  `    const timer = setTimeout(() => reject(new Error(\`Timeout: \${method}\`)), 15_000);`,
  `    ws.once('message', function handler(data) {`,
  `      const msg = JSON.parse(data.toString());`,
  `      if (msg.id !== id) { ws.once('message', handler); return; }`,
  `      clearTimeout(timer);`,
  `      if (msg.ok) resolve(msg.result);`,
  `      else reject(new Error(msg.error));`,
  `    });`,
  `    ws.send(JSON.stringify({ id, method, params, session: { id: SESSION_ID, label: SESSION_LABEL } }));`,
  `  });`,
  `}`,
  ``,
  `async function run() {`,
  `  const ws = await connect();`,
  `  console.log('[skill] connected to daemon');`,
  `  try {`,
  ...toolCalls.map(c => {
    const paramsJson = JSON.stringify(c.params, null, 4).replace(/\n/g, '\n    ');
    const method = c.tool.replace('browser_', '').replace('recorder_', 'recorder.');
    return [
      `    console.log('[skill] ${describeStep(steps[toolCalls.indexOf(c)])}');`,
      `    await call(ws, '${method}', ${paramsJson});`,
    ].join('\n');
  }),
  `    console.log('[skill] done ✓');`,
  `  } finally {`,
  `    ws.close();`,
  `  }`,
  `}`,
  ``,
  `run().catch(err => { console.error('[skill] failed:', err.message); process.exit(1); });`,
];

// ── Write files ───────────────────────────────────────────────────────────────
const mdPath = resolve(outDir, `${skillName}.md`);
const jsPath = resolve(outDir, `${skillName}.js`);

writeFileSync(mdPath, mdLines.join('\n'), 'utf8');
writeFileSync(jsPath, jsLines.join('\n'), 'utf8');

console.log(`✓ ${mdPath}`);
console.log(`✓ ${jsPath}`);
console.log(`\nTo run the skill directly:`);
console.log(`  node "${jsPath}"`);
console.log(`\nTo let Claude use it, share ${skillName}.md with your AI.`);
