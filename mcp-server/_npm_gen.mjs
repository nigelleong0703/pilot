await mcp('click', { ref: 4 });   // Generate New Token
await sleep(2500);
const snap = await mcp('snapshot', {});
const ns = snap?.result?.nodes ?? [];
console.log('NODES:', ns.map((n) => `${n.ref}:${n.role}:${n.label}`).join(' | ').slice(0, 1600));
const txt = await mcp('getText', {});
console.log('TEXT:', (txt?.result?.text ?? '').replace(/\s+/g, ' ').slice(0, 700));
process.exit(0);
