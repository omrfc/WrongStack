import { readFileSync } from 'fs';
const content = readFileSync('coverage_output.txt', 'utf8');
const lines = content.split('\n');

// Find all files with coverage < 80% statements
const lowCoverage = [];
for (const line of lines) {
  // Parse lines like: "  agent.ts         |   61.73 |    58.13 |   68.75 |   62.83 |"
  const match = line.match(/^\s*(\S+\.(?:ts|tsx|mjs|cjs)?)\s*\|\s*(\S+)/);
  if (match) {
    const pct = parseFloat(match[2]);
    if (pct < 80) {
      lowCoverage.push({ file: match[1], pct });
    }
  }
}

console.log('Files below 80% statement coverage:');
lowCoverage.sort((a, b) => a.pct - b.pct).forEach(({ file, pct }) => {
  console.log(`  ${pct.toFixed(2)}%  ${file}`);
});
console.log(`\nTotal: ${lowCoverage.length} files`);

// Files at exactly 0%
console.log('\n0% coverage files:');
for (const line of lines) {
  const match = line.match(/^\s*(\S+\.(?:ts|tsx|mjs|cjs)?)\s*\|\s*0\s*\|/);
  if (match) console.log('  ' + match[1]);
}