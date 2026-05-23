import { execSync } from 'child_process';
import { readFileSync } from 'fs';

try {
  execSync('pnpm test:coverage', { stdio: 'pipe', timeout: 300000 });
} catch (e) {
  // ignore exit code
}

const content = readFileSync('coverage_output.txt', 'utf8');
const lines = content.split('\n');

// Find the summary at the end
for (let i = lines.length - 1; i >= 0; i--) {
  const l = lines[i];
  if (l.includes('threshold') || l.includes('Coverage') || l.includes('cov') || l.includes('%') || l.includes('FAIL') || l.includes('PASS')) {
    // Print surrounding context
    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 3);
    console.log(lines.slice(start, end).join('\n'));
    console.log('---');
    break;
  }
}