import * as fs from 'node:fs';
const files = process.argv.slice(2);
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  console.log(`${f}: ${content.split(/\r?\n/).length} lines`);
}
