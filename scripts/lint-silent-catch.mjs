#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORCE = process.argv.includes('--force');
const ALL = process.argv.includes('--all');
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const HAS_BEST_EFFORT_RE = /\/\*\s*best-effort\s*\*\//;

function isTypeScript(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  return TS_EXTS.has(base.slice(base.lastIndexOf('.')));
}

function getTrackedTsFiles(all) {
  try {
    const cmd = all
      ? 'git ls-files "*.ts" "*.tsx" "*.mts" "*.cts"'
      : 'git diff --cached --name-only --diff-filter=ACM';
    const output = execSync(cmd, { encoding: 'utf8', cwd: process.cwd() });
    return output.split('\n').filter(Boolean).filter(isTypeScript);
  } catch {
    return [];
  }
}

function findUndocumentedCatches(content) {
  const lines = content.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for .catch(() => undefined) or .catch(() => null)
    const catchReturnIdx = line.indexOf('.catch(() =>');
    if (catchReturnIdx !== -1) {
      const afterArrow = line.slice(catchReturnIdx + 11);
      const isUndefinedOrNull = afterArrow.trim().startsWith('undefined') ||
                               afterArrow.trim().startsWith('null');
      if (isUndefinedOrNull) {
        const hasBestEffort = HAS_BEST_EFFORT_RE.test(line) ||
          (i > 0 && HAS_BEST_EFFORT_RE.test(lines[i - 1]));
        if (!hasBestEffort) {
          findings.push({ line: lineNum, snippet: line.trim(), type: 'silent_return' });
        }
      }
      continue;
    }

    // Check for .catch(() => {})
    const catchEmptyIdx = line.indexOf('.catch(() => {})');
    if (catchEmptyIdx !== -1) {
      const hasBestEffort = HAS_BEST_EFFORT_RE.test(line) ||
        (i > 0 && HAS_BEST_EFFORT_RE.test(lines[i - 1]));
      if (!hasBestEffort) {
        findings.push({ line: lineNum, snippet: line.trim(), type: 'silent_empty' });
      }
    }
  }

  return findings;
}

function report(filePath, findings) {
  if (findings.length === 0) return;
  console.log('\n' + filePath);
  for (const f of findings) {
    const snippet = f.snippet.length > 80 ? f.snippet.slice(0, 77) + '...' : f.snippet;
    console.log('  line ' + f.line + ': ' + f.type);
    console.log('    ' + snippet);
  }
}

const files = getTrackedTsFiles(ALL);

if (files.length === 0) {
  console.log('No TypeScript files to check.');
  process.exit(FORCE ? 0 : 1);
}

console.log('Checking ' + files.length + ' TypeScript file(s)...');

let totalFindings = 0;
const allFindings = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  if (file.includes('.test.') || file.includes('.spec.')) continue;

  const findings = findUndocumentedCatches(content);
  if (findings.length > 0) {
    allFindings.push({ file, findings });
    totalFindings += findings.length;
    report(file, findings);
  }
}

console.log('\n---');
console.log('Total: ' + totalFindings + ' undocumented silent catch handler(s) in ' + allFindings.length + ' file(s).');

if (totalFindings > 0) {
  console.log('\nTip: Add /* best-effort */ comments to document intentional silent error swallowing.');
}

process.exit(FORCE ? 0 : totalFindings > 0 ? 1 : 0);
