import * as fs from 'node:fs';
const files = ['_core-tc.log', '_cli-tc.log', '_webui-tc.log'];
for (const f of files) {
  const c = fs.readFileSync(f, 'utf8');
  const lines = c.split(/\r?\n/);
  const errLines = lines.filter((l) => l.includes('error TS'));
  console.log(`${f}: ${errLines.length} errors`);
}
