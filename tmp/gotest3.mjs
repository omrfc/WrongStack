import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const js = readFileSync('packages/tools/dist/index.js', 'utf8');
const marker = 'var GO_PARSE_SCRIPT = `';
const i = js.indexOf(marker);
const startTick = i + marker.length - 1;
let j = startTick + 1;
for (;;) {
  j = js.indexOf('`', j);
  if (js[j - 1] !== '\\') break;
  j++;
}
const literal = js.slice(startTick, j + 1);
const script = Function(`return ${literal};`)();

const dir = path.join(os.tmpdir(), 'ws-go-parse-test3');
mkdirSync(dir, { recursive: true });
const sp = path.join(dir, 'parse.go');
writeFileSync(sp, script, 'utf8');

const samples = {
  'logger.go': `package dfmc

import "fmt"

type Logger[T any] struct { level int }

func (l *Logger[T]) Info(msg string) { fmt.Println(msg) }

func New(level int) *Logger[int] { return nil }

const MaxLevel = 5
var defaultLogger = New(0)
`,
  'logger_test.go': `package applog

import "testing"

func TestLogger(t *testing.T) { t.Log("ok") }
`,
};
for (const [label, content] of Object.entries(samples)) {
  try {
    const out = execSync(`go run "${sp}"`, { input: content, timeout: 60000, encoding: 'utf8', windowsHide: true });
    console.log(`=== ${label} ===`);
    console.log(out.trim().slice(0, 900));
  } catch (e) {
    console.log(`=== ${label} ERROR ===`);
    console.log((e.stderr || e.message).toString().split('\n').slice(0, 6).join('\n'));
  }
}
