const nav = await mcp('navigate', { url: 'https://chrome.google.com/webstore/devconsole' });
console.log('nav:', nav.ok, nav.error ?? '');
await sleep(3500);
const snap = await mcp('snapshot', {});
const ns = snap?.result?.nodes ?? [];
console.log('NODES:', ns.map((n) => `${n.ref}:${n.role}:${n.label}`).join(' | ').slice(0, 1400));
const txt = await mcp('getText', {});
console.log('TEXT:', (txt?.result?.text ?? '').replace(/\s+/g, ' ').slice(0, 700));
process.exit(0);
