let s = await mcp('snapshot', {});
let ns = s?.result?.nodes ?? [];
let all = ns.find((n) => /^All packages$/i.test(n.label));
if (all) { await mcp('click', { ref: all.ref }); console.log('all packages'); }
await sleep(600);
s = await mcp('snapshot', {});
ns = s?.result?.nodes ?? [];
const gen = ns.find((n) => /^Generate token$/i.test(n.label));
if (gen) { const r = await mcp('click', { ref: gen.ref }); console.log('generate:', r.ok, r.error ?? ''); }
await sleep(3500);
s = await mcp('snapshot', {});
ns = s?.result?.nodes ?? [];
console.log('NODES:', ns.map((n) => `${n.ref}:${n.role}:${n.label}`).join(' | ').slice(0, 1600));
const txt = await mcp('getText', {});
const t = (txt?.result?.text ?? '').replace(/\s+/g, ' ');
console.log('TEXT:', t.slice(0, 700));
const tok = t.match(/npm_[A-Za-z0-9]{20,}/);
console.log('TOKEN?', tok ? tok[0].slice(0, 12) + '…' : 'none');
process.exit(0);
