import * as fs from 'node:fs';
import { globSync } from 'node:fs';

const patterns = ['packages/cli/src/**/*.ts', 'packages/webui/src/**/*.ts'];
const files = [];
for (const p of patterns) {
  for (const f of globSync(p)) {
    files.push(f);
  }
}

for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/decryptConfigSecrets\(/.test(lines[i])) {
      // Check surrounding lines for `() => undefined` vs logger
      const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 6)).join(' ');
      const isStub = /=> undefined/.test(context);
      const isLogger = /logger|noOpLogger/.test(context);
      console.log(`${f}:${i + 1}: ${isStub ? '[STUB]' : isLogger ? '[LOGGER]' : '[OTHER]'}`);
    }
  }
}
