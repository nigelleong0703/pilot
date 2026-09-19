async function findN(re) { const s = await mcp('snapshot', {}); return (s?.result?.nodes ?? []).find((n) => re.test(n.label)); }
let n = await findN(/Token name/i);
if (n) { await mcp('type', { ref: n.ref, text: 'pilot-publish' }); console.log('named'); }
n = await findN(/Bypass two-factor/i);
if (n) { await mcp('click', { ref: n.ref }); console.log('bypass on'); }
n = await findN(/^Read and write \(publish/i);
if (n) { await mcp('click', { ref: n.ref }); console.log('rw selected'); }
await sleep(1200);
const s = await mcp('snapshot', {});
const ns = s?.result?.nodes ?? [];
console.log('NODES:', ns.filter((x) => /package|scope|access|generate|organi/i.test(x.label)).map((x) => `${x.ref}:${x.role}:${x.label}`).join(' | ').slice(0, 1200));
const txt = await mcp('getText', {});
console.log('TEXT:', (txt?.result?.text ?? '').replace(/\s+/g, ' ').slice(0, 900));
process.exit(0);
