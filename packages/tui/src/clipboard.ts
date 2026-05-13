import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export interface ClipboardImage {
  base64: string;
  mediaType: 'image/png';
  bytes: number;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Read an image from the OS clipboard if one is present.
 * Returns null if no image is on the clipboard, or if the platform
 * implementation is unavailable. Throws only on unexpected I/O errors.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const platform = process.platform;
  if (platform === 'win32') return readWindows();
  if (platform === 'darwin') return readDarwin();
  if (platform === 'linux') return readLinux();
  return null;
}

async function readWindows(): Promise<ClipboardImage | null> {
  // Save the clipboard image (if any) to a temp PNG via PowerShell, then
  // read the bytes back. The script prints "OK" or "NO_IMAGE" to stdout
  // so we can distinguish "no image" from "powershell failure".
  const tmp = path.join(os.tmpdir(), `wstack-clip-${Date.now()}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { Write-Output "NO_IMAGE"; exit 0 }',
    `$img.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'Write-Output "OK"',
  ].join('; ');
  const out = await runCmd('powershell', ['-NoProfile', '-Command', ps]);
  if (!out || out.trim() === 'NO_IMAGE') return null;
  if (!out.includes('OK')) return null;
  return readPngFile(tmp);
}

async function readDarwin(): Promise<ClipboardImage | null> {
  // AppleScript: write clipboard image to a temp file. If the clipboard
  // doesn't hold an image, the script errors out — we treat that as "no image".
  const tmp = path.join(os.tmpdir(), `wstack-clip-${Date.now()}.png`);
  const script = [
    'try',
    `  set the_file to (open for access POSIX file "${tmp}" with write permission)`,
    '  write (the clipboard as «class PNGf») to the_file',
    '  close access the_file',
    'on error',
    '  try',
    '    close access POSIX file "' + tmp + '"',
    '  end try',
    '  return "NO_IMAGE"',
    'end try',
    'return "OK"',
  ].join('\n');
  const out = await runCmd('osascript', ['-e', script]);
  if (!out || out.trim() !== 'OK') return null;
  return readPngFile(tmp);
}

async function readLinux(): Promise<ClipboardImage | null> {
  // Try wl-paste (Wayland) first, then xclip. Both write the PNG to stdout
  // when the clipboard holds an image, and fail otherwise.
  const tmp = path.join(os.tmpdir(), `wstack-clip-${Date.now()}.png`);
  const tries: Array<[string, string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  for (const [cmd, args] of tries) {
    const ok = await runCmdToFile(cmd, args, tmp).catch(() => false);
    if (ok) return readPngFile(tmp);
  }
  return null;
}

async function readPngFile(p: string): Promise<ClipboardImage | null> {
  try {
    const buf = await fs.readFile(p);
    if (buf.length === 0) {
      await fs.unlink(p).catch(() => undefined);
      return null;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      await fs.unlink(p).catch(() => undefined);
      throw new Error(`Clipboard image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`);
    }
    // Sanity check: PNG magic bytes.
    if (
      buf[0] !== 0x89 ||
      buf[1] !== 0x50 ||
      buf[2] !== 0x4e ||
      buf[3] !== 0x47
    ) {
      await fs.unlink(p).catch(() => undefined);
      return null;
    }
    await fs.unlink(p).catch(() => undefined);
    return { base64: buf.toString('base64'), mediaType: 'image/png', bytes: buf.length };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function runCmd(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? out : null));
  });
}

function runCmdToFile(cmd: string, args: string[], outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve(false));
    child.on('exit', async (code) => {
      if (code !== 0 || chunks.length === 0) return resolve(false);
      try {
        await fs.writeFile(outPath, Buffer.concat(chunks));
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  });
}
