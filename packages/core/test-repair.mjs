/**
 * Test file for json-repair.ts — validates the completePartialObject repair logic.
 * Run with: node test-repair.mjs
 *
 * Known limitations (documented in completePartialObject):
 * - Strings whose content ends with a `"` character cannot be reliably repaired
 *   (the algorithm can't distinguish a content-`"` from a string-terminator `"`).
 * - Input ending in bare `:` (incomplete value expression) can't be meaningfully repaired.
 * - Bare `{` returns unchanged since no useful structure can be inferred.
 *
 * Strategy:
 * 1. Add exactly origOpen closing braces (origOpen = brace count from ORIGINAL input).
 * 2. If still invalid after step 1, trim trailing whitespace, strip trailing backslash.
 * 3. Walk backwards: if we end up inside a string (unclosed opening quote), the stream
 *    was truncated mid-string-value — remove the dangling opening quote, append closing "
 *    and origOpen closing braces.
 */

function braceDepth(str) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of str) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

function tryParse(s) {
  try { JSON.parse(s); return { ok: true }; }
  catch { return { ok: false }; }
}

function completePartialObject(s) {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{')) return s;

  const origOpen = braceDepth(s);
  let result = s;

  if (origOpen > 0) result += '}'.repeat(origOpen);
  if (tryParse(result).ok) return result;

  result = result.trimEnd();
  if (result.endsWith('\\')) result = result.slice(0, -1);

  let inString = false;
  let escaped = false;
  for (let i = result.length - 1; i >= 0; i--) {
    const ch = result[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      let nextNonWs;
      for (let j = i + 1; j < result.length; j++) {
        const nc = result[j];
        if (nc === ' ' || nc === '\t' || nc === '\n' || nc === '\r') continue;
        nextNonWs = nc;
        break;
      }
      if (nextNonWs === ':') continue;
      inString = !inString;
    }
  }

  if (inString) {
    result = result.slice(0, -1);
    result += '"' + '}'.repeat(origOpen);
  }

  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

const cases = [
  // Valid JSON — pass through unchanged
  { input: '{"a":1}', expected: '{"a":1}', note: 'already valid' },
  { input: '{"a":1,"b":"hello"}', expected: '{"a":1,"b":"hello"}', note: 'already valid multi-field' },
  { input: '{"port":80}', expected: '{"port":80}', note: 'number value, closed' },

  // Trailing whitespace on valid JSON — trimmed by trimEnd() → still valid
  { input: '{"a":"hello"  ', expected: '{"a":"hello"}', note: 'trailing spaces on valid JSON' },

  // origOpen=1 from number value — add 1 }, parse succeeds
  { input: '{"port":80', expected: '{"port":80}', note: 'unclosed object with number value' },

  // origOpen=0 (already balanced) but with trailing whitespace
  { input: '{"a":{"b":1}', expected: '{"a":{"b":1}}', note: 'nested object, balanced' },

  // origOpen=1 from nested object — add 1 }
  { input: '{"a":{"b":1}', expected: '{"a":{"b":1}}', note: 'nested object, one open' },

  // origOpen=3 — three levels of unclosed
  { input: '{"a":{"b":{"c":true}', expected: '{"a":{"b":{"c":true}}}', note: 'deeply nested all unclosed' },

  // origOpen=1, string contains literal newline — add }, parse succeeds
  {
    input: '{"path":"foo.txt","old_string":"line1\nline2',
    expected: '{"path":"foo.txt","old_string":"line1\nline2"}',
    note: 'two-field, string with literal newline'
  },

  // origOpen=1, escaped \n in source (literal backslash-n in JSON string value)
  {
    input: '{"path":"src/app.tsx","old_string":"line1\\nline2',
    expected: '{"path":"src/app.tsx","old_string":"line1\\nline2"}',
    note: 'edit-tool truncation with escaped newline'
  },

  // origOpen=2: nested object + string wrapper. After adding 2 }, it's valid JSON
  {
    input: '{"edit":{"old_string":"a{"',
    expected: '{"edit":{"old_string":"a{}"}',
    note: 'string containing literal brace — brace fix is enough'
  },

  // origOpen=1: unclosed array. After adding 1 }, it's valid
  { input: '{"files":["a","b"', expected: '{"files":["a","b"]}', note: 'unclosed array value' },

  // String containing : or , in value
  { input: '{"url":"http://example.com', expected: '{"url":"http://example.com"}', note: 'url value (colon inside string)' },
  { input: '{"tags":"a,b,c', expected: '{"tags":"a,b,c"}', note: 'comma in string value' },

  // Escape sequence edge cases
  { input: '{"msg":"hello\\"world', expected: '{"msg":"hello\\"world"}', note: 'escaped quote in string' },

  // Bare `{` — nothing useful can be done
  { input: '{', expected: '{', note: 'bare open brace' },

  // Unclosed string at end: origOpen=1, add }, still invalid, walk detects inString,
  // remove last " → result='{"a":"hello', add '"'+'}' → '{"a":"hello"}'
  { input: '{"a":"hello', expected: '{"a":"hello"}', note: 'unclosed string value (core streaming case)' },
  { input: '{"a":"hello\nworld', expected: '{"a":"hello\nworld"}', note: 'unclosed string with literal newline' },

  // Array with escaped quote in string value
  { input: '{"items":["a\\"b"]', expected: '{"items":["a\\"b"]}', note: 'array with escaped quote, balanced' },
];

let passed = 0, failed = 0;
for (const c of cases) {
  const out = completePartialObject(c.input);
  if (out === c.expected) {
    passed++;
    console.log('PASS:', c.note);
  } else {
    failed++;
    console.log('FAIL:', c.note);
    console.log('  input   :', JSON.stringify(c.input));
    console.log('  got     :', JSON.stringify(out));
    console.log('  expected:', JSON.stringify(c.expected));
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);