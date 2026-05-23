import { readFileSync } from 'fs';
const content = readFileSync('coverage_output.txt', 'utf8');
const lines = content.split('\n');
// Print lines from 407 onwards (test summary + coverage table)
for (let i = 407; i < lines.length; i++) {
  console.log(i + ': ' + lines[i]);
}