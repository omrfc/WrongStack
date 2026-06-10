import * as fs from 'node:fs';
const c = fs.readFileSync('_cli-tc.log', 'utf8');
const lines = c.split(/\r?\n/);
for (const l of lines) {
  if (l.includes('error TS')) console.log(l);
}
