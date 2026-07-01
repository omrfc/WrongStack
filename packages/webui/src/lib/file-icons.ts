import {
  File,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileText,
  FileType,
} from 'lucide-react';

// ── File icon by extension ────────────────────────────────────────────

const EXT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  // ── Code ──
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  // ── Data / config ──
  json: FileJson,
  lock: FileLock,
  // ── Styles ──
  css: FileText,
  scss: FileText,
  less: FileText,
  // ── Markup ──
  html: FileType,
  htm: FileType,
  svg: FileImage,
  xml: FileType,
  // ── Docs ──
  md: FileText,
  mdx: FileText,
  txt: FileText,
  // ── Config / data formats ──
  yml: FileText,
  yaml: FileText,
  toml: FileCog,
  env: FileCog,
  gitignore: FileCog,
  editorconfig: FileCog,
  // ── Scripts ──
  sh: FileCode,
  bash: FileCode,
  zsh: FileCode,
  fish: FileCode,
  ps1: FileCode,
  bat: FileCode,
  // ── Python ──
  py: FileCode,
  pyi: FileCode,
  pyx: FileCode,
  // ── Rust ──
  rs: FileCode,
  // ── Go ──
  go: FileCode,
  // ── Other languages ──
  rb: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  hpp: FileCode,
  sql: FileCode,
  graphql: FileCode,
  // ── Images ──
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  ico: FileImage,
};

/**
 * Returns a Tailwind text color class for a file extension.
 * Colors match the WrongStack semantic palette — same hues used in
 * syntax highlighting and Monaco editor themes for visual consistency.
 */
export function fileIconColor(
  name: string,
  isDirectory: boolean,
): string {
  if (isDirectory) {
    // Special directories get distinct colors
    const lower = name.toLowerCase();
    if (lower === '.git') return 'text-orange-500/80 dark:text-orange-400/80';
    if (lower === 'node_modules') return 'text-red-400/60 dark:text-red-500/60';
    if (lower === 'src' || lower === 'lib' || lower === 'packages')
      return 'text-amber-500/70 dark:text-amber-400/70';
    if (lower === 'tests' || lower === 'test' || lower === '__tests__')
      return 'text-emerald-500/70 dark:text-emerald-400/70';
    if (lower === 'dist' || lower === 'build' || lower === '.next')
      return 'text-muted-foreground/50';
    return 'text-amber-500/70 dark:text-amber-400/70';
  }

  const ext = name.split('.').pop()?.toLowerCase() ?? '';

  // ── TypeScript / JavaScript → blue (function/type color) ──
  if (/^(ts|tsx|js|jsx|mjs|cjs)$/.test(ext))
    return 'text-blue-500 dark:text-blue-400';

  // ── JSON / lockfiles → amber (number/constant color) ──
  if (/^(json|lock)$/.test(ext)) return 'text-amber-500 dark:text-amber-400';

  // ── CSS / styles → teal (regex color) ──
  if (/^(css|scss|less|sass)$/.test(ext)) return 'text-teal-500 dark:text-teal-400';

  // ── HTML / markup → rose (tag color) ──
  if (/^(html|htm|xml|svg)$/.test(ext)) return 'text-rose-500 dark:text-rose-400';

  // ── Markdown / docs → violet (decorator color) ──
  if (/^(md|mdx)$/.test(ext)) return 'text-violet-500 dark:text-violet-400';

  // ── YAML / TOML / env → green (string color) ──
  if (/^(yml|yaml|toml|env)$/.test(ext)) return 'text-emerald-500 dark:text-emerald-400';

  // ── Shell scripts → warm gray ──
  if (/^(sh|bash|zsh|fish|ps1|bat)$/.test(ext))
    return 'text-orange-400 dark:text-orange-300';

  // ── Python → blue-amber gradient feel ──
  if (/^(py|pyi|pyx)$/.test(ext)) return 'text-cyan-500 dark:text-cyan-400';

  // ── Rust → rust orange ──
  if (ext === 'rs') return 'text-orange-500 dark:text-orange-400';

  // ── Go → go blue ──
  if (ext === 'go') return 'text-sky-500 dark:text-sky-400';

  // ── Ruby → red ──
  if (ext === 'rb') return 'text-red-400 dark:text-red-400';

  // ── C / C++ → slate ──
  if (/^(c|h|cpp|hpp|cc|hh)$/.test(ext)) return 'text-slate-500 dark:text-slate-400';

  // ── Images → purple ──
  if (/^(png|jpe?g|gif|webp|ico)$/.test(ext)) return 'text-purple-500 dark:text-purple-400';

  // ── Config files ──
  if (/^(gitignore|editorconfig|prettierrc|eslintrc)$/.test(ext))
    return 'text-muted-foreground/60';

  return 'text-muted-foreground';
}

export function fileIcon(
  name: string,
): React.ComponentType<{ className?: string }> {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_ICONS[ext] ?? File;
}
