const nav = await mcp('navigate', { url: 'https://www.npmjs.com/settings/nigelleong0703/tokens' });
console.log('nav:', nav.ok, nav.error ?? '');
await sleep(3000);
const snap = await mcp('snapshot', {});
const ns = snap?.result?.nodes ?? [];
console.log('NODES:', ns.map((n) => `${n.ref}:${n.role}:${n.label}`).join(' | ').slice(0, 1600));
const txt = await mcp('getText', {});
console.log('TEXT:', (txt?.result?.text ?? '').replace(/\s+/g, ' ').slice(0, 600));
process.exit(0);
