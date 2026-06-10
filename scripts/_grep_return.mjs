import * as fs from 'node:fs';
const src = fs.readFileSync('packages/cli/src/boot.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('  return {') || lines[i].startsWith('return {')) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
  if (lines[i].includes('logger,') && i > 100) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
}
