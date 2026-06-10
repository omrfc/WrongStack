import * as fs from 'node:fs';
const src = fs.readFileSync('packages/core/src/infrastructure/logger.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export') || lines[i].includes('Logger')) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
}
