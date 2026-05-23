const c = require('.\\coverage\\coverage-final.json');
const files = Object.keys(c).filter(k => k !== 'total' && c[k].s);
const rows = [];
for (const f of files) {
  const s = c[f].s, skeys = Object.keys(s);
  const hit = skeys.filter(k => s[k] > 0).length;
  const total = skeys.length;
  rows.push({ file: f, hit, total, pct: (hit/total*100).toFixed(1) });
}
rows.sort((a,b) => a.pct - b.pct);
// Print 0% files
for (const r of rows) {
  if (r.pct === '0.0') console.log(`${r.hit}/${r.total} ${r.file}`);
}