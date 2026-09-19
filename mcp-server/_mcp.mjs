import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:9235');
let id = 0; const pend = new Map();
ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
globalThis.mcp = (mth, p = {}) => new Promise((res) => { const i = 'c' + (++id); pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mth, params: p, session: { id: 'cws', label: 'cws' } })); });
globalThis.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.on('open', async () => { await import(process.argv[2]); });
ws.on('error', (e) => { console.log('WS ERR', e.message); process.exit(1); });
