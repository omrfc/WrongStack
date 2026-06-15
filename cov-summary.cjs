const fs = require('node:fs');
const cov = JSON.parse(fs.readFileSync('coverage/coverage-final.json', 'utf8'));
const pkg = {};
for (const [file, data] of Object.entries(cov)) {
  const norm = file.split('\\').join('/');
  const m = norm.match(/packages\/([^/]+)\/src\//);
  if (!m) continue;
  const p = m[1];
  pkg[p] = pkg[p] || { sCov: 0, sTot: 0, bCov: 0, bTot: 0, fCov: 0, fTot: 0, files: 0 };
  const o = pkg[p];
  o.files++;
  const s = data.s || {};
  for (const k in s) { o.sTot++; if (s[k] > 0) o.sCov++; }
  const f = data.f || {};
  for (const k in f) { o.fTot++; if (f[k] > 0) o.fCov++; }
  const b = data.b || {};
  for (const k in b) { for (const v of b[k]) { o.bTot++; if (v > 0) o.bCov++; } }
}
const rows = Object.entries(pkg).map(([p, o]) => ({
  p,
  st: 100 * o.sCov / (o.sTot || 1),
  br: 100 * o.bCov / (o.bTot || 1),
  fn: 100 * o.fCov / (o.fTot || 1),
  files: o.files,
  gap: o.sTot - o.sCov,
}));
rows.sort((a, b) => a.st - b.st);
console.log('pkg'.padEnd(12), 'stmt%'.padStart(7), 'branch%'.padStart(8), 'func%'.padStart(7), 'files'.padStart(6), 'uncovStmt'.padStart(10));
for (const r of rows) {
  console.log(r.p.padEnd(12), r.st.toFixed(1).padStart(7), r.br.toFixed(1).padStart(8), r.fn.toFixed(1).padStart(7), String(r.files).padStart(6), String(r.gap).padStart(10));
}
