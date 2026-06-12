#!/usr/bin/env node
/**
 * Guards against silent Promise rejection handlers without `/* best-effort */` comments.
 *
 * The codebase uses `/* best-effort */` comments to document intentional silent
 * error swallowing for non-critical operations. This script flags catches that lack
 * this documentation, making it easier to identify accidental swallow vs intentional.
 *
 * Usage:
 *   node scripts/lint-silent-catch.mjs           # scan staged TS files
 *   node scripts/lint-silent-catch.mjs --all      # scan all tracked TS files
 *   node scripts/lint-silent-catch.mjs --force    # exit 0 regardless
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORCE = process.argv.includes('--force');
const ALL = process.argv.includes('--all');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// Matches a line that has `/* best-effort */`
const HAS_BEST_EFFORT_RE = /\/\*\s*best-effort\s*\*\//;

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

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

// ── Core check ──────────────────────────────────────────────────────

/**
 * Finds undocumented silent catch handlers in a file.
 * Returns array of { line, snippet, type }
 */
function findUndocumentedCatches(content, filePath) {
  const lines = content.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for .catch(() => undefined) or .catch(() => null) without best-effort
    const catchReturnIdx = line.indexOf('.catch(() =>');
    if (catchReturnIdx !== -1) {
      const afterArrow = line.slice(catchReturnIdx + 11); // ".catch(() =>" = 11 chars
      const isUndefinedOrNull = afterArrow.trim().startsWith('undefined') ||
                               afterArrow.trim().startsWith('null');
      if (isUndefinedOrNull) {
        // Check if this line or the previous line has best-effort
        const hasBestEffort = HAS_BEST_EFFORT_RE.test(line) ||
          (i > 0 && HAS_BEST_EFFORT_RE.test(lines[i - 1]));
        if (!hasBestEffort) {
          findings.push({
            line: lineNum,
            snippet: line.trim(),
            type: 'silent_return',
          });
        }
      }
      continue;
    }

    // Check for .catch(() => {}) without best-effort
    const catchEmptyIdx = line.indexOf('.catch(() => {})');
    if (catchEmptyIdx !== -1) {
      const hasBestEffort = HAS_BEST_EFFORT_RE.test(line) ||
        (i > 0 && HAS_BEST_EFFORT_RE.test(lines[i - 1]));
      if (!hasBestEffort) {
        findings.push({
          line: lineNum,
          snippet: line.trim(),
          type: 'silent_empty',
        });
      }
      continue;
    }

    // Check for .catch(() => { ... }) multi-line patterns
    const catchArrowIdx = line.indexOf('.catch(() =>');
    if (catchArrowIdx !== -1) {
      // Check if it's a multi-line block
      const nextLine = lines[i + 1] ?? '';
      if (nextLine.trim().startsWith('{')) {
        // Look for the closing brace
        let closingIdx = i + 1;
        let depth = 0;
        let fullBlock = '';
        while (closingIdx < lines.length) {
          const l = lines[closingIdx];
          fullBlock += '\n' + l;
          depth += (l.match(/\{/g) || []).length;
          depth -= (l.match(/\}/g) || []).length;
          if (depth <= 0) break;
          closingIdx++;
        }

        // Extract block content between braces
        const firstBrace = fullBlock.indexOf('{');
        const lastBrace = fullBlock.lastIndexOf('}');
        const blockBody = fullBlock.slice(firstBrace + 1, lastBrace).trim();

        // Check if the catch block is empty (just whitespace, comments)
        const isEmptyBlock = blockBody === '' ||
          /^\s*(\/\/[^\n]*)?\s*$/.test(blockBody);

        if (isEmptyBlock) {
          const hasBestEffort = HAS_BEST_EFFORT_RE.test(fullBlock);
          if (!hasBestEffort) {
            findings.push({
              line: lineNum,
              snippet: fullBlock.split('\n').slice(1).map(l => l.trim()).join(' '),
              type: 'silent_multiline_empty',
            });
          }
        }
      }
    }
  }

  return findings;
}

// ── Reporter ───────────────────────────────────────────────────────

function report(filePath, findings) {
  if (findings.length === 0) return;

  console.log('\n' + filePath);
  for (const f of findings) {
    console.log('  line ' + f.line + ': ' + f.type);
    const snippet = f.snippet.length > 80 ? f.snippet.slice(0, 77) + '...' : f.snippet;
    console.log('    ' + snippet);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

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

  // Skip test files
  if (file.includes('.test.') || file.includes('.spec.')) continue;

  const findings = findUndocumentedCatches(content, file);
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
