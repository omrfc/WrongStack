// Mouse-input diagnostic that mirrors the SHIPPED fix.
//   node mouse-diag.mjs
// 1) enters raw mode + enables SGR mouse tracking,
// 2) applies the Windows VT-console-input fix (same SetConsoleMode the TUI now
//    does), so mouse VT sequences are actually delivered to stdin,
// 3) prints every stdin chunk, tagging mouse sequences, and writes a summary to
//    mouse-diag-result.json.
// Move + click the mouse, type a few keys, then press q (auto-stops after 25s).

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = process.stdout;
const inp = process.stdin;

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const isMouse = (s) => /\x1b?\[<\d+;\d+;\d+[Mm]/.test(s);

const result = {
  node: process.version,
  platform: process.platform,
  isTTY: { stdin: !!inp.isTTY, stdout: !!out.isTTY },
  vtFix: { attempted: false, status: null, oldMode: null, newMode: null },
  mouseChunks: 0,
  keyChunks: 0,
  samples: [],
};

function applyVtInputFix() {
  if (process.platform !== 'win32') return;
  result.vtFix.attempted = true;
  const ps = [
    "$s=@'",
    'using System;using System.Runtime.InteropServices;',
    'public static class CM{',
    '[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);',
    '[DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetConsoleMode(IntPtr h,out uint m);',
    '[DllImport("kernel32.dll",SetLastError=true)]public static extern bool SetConsoleMode(IntPtr h,uint m);}',
    "'@",
    'Add-Type -TypeDefinition $s',
    '$h=[CM]::CreateFileW("CONIN$",[uint32]3221225472,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]0,[IntPtr]::Zero)',
    '$m=0',
    'if([CM]::GetConsoleMode($h,[ref]$m)){',
    ' $n=([uint32]($m -bor 0x80 -bor 0x200 -bor 0x10)) -band (-bnot ([uint32](0x40 -bor 0x2 -bor 0x4 -bor 0x1)))',
    ' [void][CM]::SetConsoleMode($h,$n)',
    ' Write-Output ("OLD=0x{0:X} NEW=0x{1:X}" -f $m,$n)',
    '}',
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8' },
  );
  result.vtFix.status = r.status;
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const m = text.match(/OLD=0x([0-9A-F]+) NEW=0x([0-9A-F]+)/i);
  if (m) {
    result.vtFix.oldMode = `0x${m[1]}`;
    result.vtFix.newMode = `0x${m[2]}`;
  } else {
    result.vtFix.status = `${result.vtFix.status} ${text}`.trim();
  }
}

let done = false;
function finish() {
  if (done) return;
  done = true;
  try {
    out.write(MOUSE_OFF);
    inp.setRawMode?.(false);
  } catch {}
  try {
    writeFileSync('mouse-diag-result.json', JSON.stringify(result, null, 2));
  } catch {}
  out.write(`\r\n--------------------------------------------------------------------\r\n`);
  out.write(
    `mouse chunks: ${result.mouseChunks}   key chunks: ${result.keyChunks}\r\n` +
      `Wrote mouse-diag-result.json. ${result.mouseChunks > 0 ? 'MOUSE WORKS ✓' : 'NO MOUSE BYTES ✗'}\r\n`,
  );
  process.exit(0);
}

out.write(`platform=${process.platform} node=${process.version} isTTY=${inp.isTTY}\r\n`);
inp.setRawMode?.(true); // libuv raw mode FIRST (it clears VT input)…
applyVtInputFix(); // …then layer VT input on top, exactly like the TUI does.
out.write(`vt-input fix: ${JSON.stringify(result.vtFix)}\r\n`);
out.write(MOUSE_ON);
inp.setEncoding('utf8');
inp.resume();
out.write('Now MOVE and CLICK the mouse in this window, type some keys, then press q.\r\n');
out.write('--------------------------------------------------------------------\r\n');

inp.on('data', (d) => {
  const s = String(d);
  if (s === 'q' || s === '\x03') return finish();
  if (isMouse(s)) {
    result.mouseChunks++;
    if (result.samples.length < 6) result.samples.push(JSON.stringify(s));
    out.write(`[MOUSE ✓] ${JSON.stringify(s)}\r\n`);
  } else {
    result.keyChunks++;
    out.write(`[key]     ${JSON.stringify(s)}\r\n`);
  }
});

setTimeout(finish, 25000);
process.on('SIGINT', finish);
process.on('exit', () => {
  try {
    out.write(MOUSE_OFF);
    inp.setRawMode?.(false);
  } catch {}
});
