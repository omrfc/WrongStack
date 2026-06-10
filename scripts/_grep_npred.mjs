import * as fs from 'node:fs';
const src = fs.readFileSync('packages/cli/src/execution.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('nextPrediction') || lines[i].includes('featureMcp') || lines[i].includes('noOpVault')) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
}
