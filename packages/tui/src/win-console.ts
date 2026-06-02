import { spawn } from 'node:child_process';

// Windows-only fix for "mouse does nothing" in --mouse mode.
//
// Node's `setRawMode(true)` puts the console in libuv's UV_TTY_MODE_RAW, which
// sets ENABLE_EXTENDED_FLAGS but does NOT set ENABLE_VIRTUAL_TERMINAL_INPUT.
// Without VT input the console hands mouse activity to libuv as MOUSE_EVENT
// input records — and libuv's Windows TTY reader only translates KEY_EVENT
// records to bytes, silently discarding every mouse event. The terminal happily
// emits SGR mouse sequences (we asked for them via DECSET ?1000/?1002/?1006),
// but they never reach process.stdin, so the TUI sees nothing.
//
// With ENABLE_VIRTUAL_TERMINAL_INPUT set, the console instead packs mouse (and
// key) input as the raw VT byte sequence inside KEY_EVENT records, which libuv
// DOES forward — so `\x1b[<…M` lands on stdin exactly like it does on Unix.
//
// Node exposes no SetConsoleMode binding, so we flip the mode out-of-band via a
// short-lived PowerShell child. The console input buffer's mode is a property of
// the CONSOLE, shared by every attached process, so a child opening `CONIN$` and
// calling SetConsoleMode changes the mode our own libuv reader observes. This is
// best-effort: any failure (no PowerShell, locked-down policy, non-console host)
// is swallowed and simply leaves mouse non-functional, exactly as before.

const PS_SCRIPT = [
  "$s=@'",
  'using System;using System.Runtime.InteropServices;',
  'public static class CM{',
  '[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);',
  '[DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetConsoleMode(IntPtr h,out uint m);',
  '[DllImport("kernel32.dll",SetLastError=true)]public static extern bool SetConsoleMode(IntPtr h,uint m);}',
  "'@",
  'Add-Type -TypeDefinition $s',
  // CreateFileW("CONIN$", GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|WRITE, 0, OPEN_EXISTING, 0, 0)
  '$h=[CM]::CreateFileW("CONIN$",[uint32]3221225472,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]0,[IntPtr]::Zero)',
  '$m=0',
  'if([CM]::GetConsoleMode($h,[ref]$m)){',
  // +ENABLE_EXTENDED_FLAGS(0x80) +ENABLE_VIRTUAL_TERMINAL_INPUT(0x200) +ENABLE_MOUSE_INPUT(0x10)
  // -ENABLE_QUICK_EDIT_MODE(0x40) -ENABLE_LINE_INPUT(0x02) -ENABLE_ECHO_INPUT(0x04) -ENABLE_PROCESSED_INPUT(0x01)
  ' $n=([uint32]($m -bor 0x80 -bor 0x200 -bor 0x10)) -band (-bnot ([uint32](0x40 -bor 0x2 -bor 0x4 -bor 0x1)))',
  ' [void][CM]::SetConsoleMode($h,$n)',
  '}',
].join('\n');

/**
 * Best-effort: enable ENABLE_VIRTUAL_TERMINAL_INPUT on the shared Windows
 * console input so mouse VT sequences are delivered to stdin. No-op (and never
 * throws) off win32 or if PowerShell is unavailable. MUST be called AFTER Node's
 * `setRawMode(true)` (libuv's raw mode clears VT input), so the change isn't
 * immediately clobbered.
 */
export function enableWindowsMouseInput(): void {
  if (process.platform !== 'win32') return;
  try {
    // -EncodedCommand takes base64 of the UTF-16LE script text — avoids every
    // quoting pitfall of passing a multi-line C# heredoc through argv.
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    // No windowsHide: a console child must stay attached to THIS console so
    // CONIN$ resolves to the same input buffer libuv reads. stdio 'ignore'
    // redirects its std handles but does not detach the console attachment.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: 'ignore' },
    );
    child.on('error', () => {
      // PowerShell missing / blocked — leave mouse disabled, never crash the TUI.
    });
    child.unref();
  } catch {
    // spawn threw synchronously (extremely rare) — ignore.
  }
}
