import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { checkForUpdate } from '../../update-check.js';
import type { SubcommandHandler } from '../index.js';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface ParsedUpdateArgs {
  checkOnly: boolean;
  packageManager: PackageManager | undefined;
  /** Default false — pass --ignore-scripts to the package manager. */
  allowScripts: boolean;
  error: string | undefined;
}

interface UpdateCommand {
  executable: string;
  args: string[];
  display: string;
}

/** `wrongstack update` — Update the CLI via the detected global package manager. */
export const updateCmd: SubcommandHandler = async (args, deps) => {
  const cwd = deps.cwd;

  const parsed = parseUpdateArgs(args);
  if (parsed.error) {
    deps.renderer.write(`${parsed.error}\n`);
    deps.renderer.write(
      'Usage: wrongstack update [--check-only] [--pm npm|pnpm|yarn|bun] [--allow-scripts]\n',
    );
    return 1;
  }

  const info = await checkForUpdate();

  if (parsed.checkOnly) {
    if (info.outdated) {
      deps.renderer.write(`Update available: v${info.current} → v${info.latest}\n`);
    } else {
      deps.renderer.write(`You are on the latest version: v${info.current}\n`);
    }
    return 0;
  }

  if (!info.outdated) {
    deps.renderer.write(`You are already on the latest version: v${info.current}\n`);
    return 0;
  }

  const packageManager = parsed.packageManager ?? detectUpdatePackageManager();
  const updateCommand = buildUpdateCommand(packageManager, { allowScripts: parsed.allowScripts });

  deps.renderer.write(`Updating wrongstack from v${info.current} to v${info.latest}...\n`);
  deps.renderer.write(`Running: ${updateCommand.display}\n`);

  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(updateCommand.executable, updateCommand.args, {
          cwd,
          stdio: 'pipe',
          signal: AbortSignal.timeout(120_000),
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
          stdout += d;
        });
        child.stderr?.on('data', (d) => {
          stderr += d;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
      },
    );

    if (result.code === 0) {
      deps.renderer.write(
        `\nUpdated to v${info.latest}. Restart wrongstack to use the new version.\n`,
      );
      const warning = installWarningSummary(`${result.stderr}\n${result.stdout}`);
      if (warning) deps.renderer.write(`\n${warning}\n`);
    } else {
      // A bare "exit code 243" is opaque — npm's actual reason (EACCES, a custom
      // prefix it can't write, a pnpm/yarn/bun global that npm doesn't own) lives
      // in stderr, which used to be collected and thrown away (#13). Surface it,
      // then point at the package-manager-specific update command so users who
      // didn't install via npm have a working path forward.
      deps.renderer.write(`\nUpdate failed with exit code ${result.code}.\n`);
      const detail = `${result.stderr}\n${result.stdout}`.trim();
      if (detail) deps.renderer.write(`\n${detail}\n`);
      deps.renderer.write(
        `\nTry the matching global update command manually:\n  ${updateCommand.display}\n` +
          otherManagerCommands(packageManager, { allowScripts: parsed.allowScripts }),
      );
    }
    return result.code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      deps.renderer.write(`\nUpdate failed: ${packageManager} not found in PATH.\n`);
      return 1;
    }
    deps.renderer.write(`\nUpdate failed: ${msg}\n`);
    return 1;
  }
};

function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  let checkOnly = false;
  let packageManager: PackageManager | undefined;
  let allowScripts = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--check-only' || arg === '-c') {
      checkOnly = true;
      continue;
    }
    if (arg === '--pm' || arg === '--package-manager') {
      const value = args[++i];
      const pm = parsePackageManager(value);
      if (!pm)
        return {
          checkOnly,
          packageManager,
          allowScripts,
          error: `Invalid package manager: ${value ?? '<missing>'}`,
        };
      packageManager = pm;
      continue;
    }
    const pmEq = arg.match(/^--(?:pm|package-manager)=(.+)$/)?.[1];
    if (pmEq) {
      const pm = parsePackageManager(pmEq);
      if (!pm)
        return { checkOnly, packageManager, allowScripts, error: `Invalid package manager: ${pmEq}` };
      packageManager = pm;
      continue;
    }
    const shorthand = arg.match(/^--(npm|pnpm|yarn|bun)$/)?.[1];
    if (shorthand) {
      packageManager = shorthand as PackageManager;
    }
    if (arg === '--allow-scripts' || arg === '--lifecycle-scripts') {
      allowScripts = true;
    }
  }

  return { checkOnly, packageManager, allowScripts, error: undefined };
}

function parsePackageManager(value: string | undefined): PackageManager | undefined {
  if (value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun') return value;
  return undefined;
}

export function detectUpdatePackageManager(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): PackageManager {
  const forced = parsePackageManager(env.WRONGSTACK_UPDATE_PM);
  if (forced) return forced;

  const userAgent = env.npm_config_user_agent ?? '';
  if (/\bpnpm\//i.test(userAgent)) return 'pnpm';
  if (/\byarn\//i.test(userAgent)) return 'yarn';
  if (/\bbun\//i.test(userAgent)) return 'bun';
  if (/\bnpm\//i.test(userAgent)) return 'npm';

  const execPath = `${env.npm_execpath ?? ''} ${argv[1] ?? ''}`;
  const realPaths = [env.npm_execpath, argv[1]]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => {
      try {
        return existsSync(p) ? realpathSync(p) : p;
      } catch {
        return p;
      }
    })
    .join(' ');
  const hint = `${execPath} ${realPaths}`.replace(/\\/g, '/').toLowerCase();
  if (hint.includes('/pnpm/') || hint.includes('/.pnpm/') || hint.includes('pnpm-global'))
    return 'pnpm';
  if (hint.includes('/yarn/') || hint.includes('/.yarn/')) return 'yarn';
  if (hint.includes('/bun/') || hint.includes('/.bun/')) return 'bun';
  return 'npm';
}

function buildUpdateCommand(
  packageManager: PackageManager,
  opts: { allowScripts: boolean } = { allowScripts: false },
): UpdateCommand {
  // Default to --ignore-scripts so a compromised `wrongstack@latest` cannot
  // run arbitrary code in the user's postinstall. Opt back in with
  // --allow-scripts for the legacy behavior. The flag is supported on all
  // four managers (`npm install -g`, `pnpm add -g`, `yarn global add`,
  // `bun add -g`).
  const ignoreScripts = !opts.allowScripts;
  switch (packageManager) {
    case 'pnpm':
      return command(
        packageManager,
        ignoreScripts
          ? ['add', '-g', '--ignore-scripts', 'wrongstack@latest']
          : ['add', '-g', 'wrongstack@latest'],
      );
    case 'yarn':
      return command(
        packageManager,
        ignoreScripts
          ? ['global', 'add', '--ignore-scripts', 'wrongstack@latest']
          : ['global', 'add', 'wrongstack@latest'],
      );
    case 'bun':
      return command(
        packageManager,
        ignoreScripts
          ? ['add', '-g', '--ignore-scripts', 'wrongstack@latest']
          : ['add', '-g', 'wrongstack@latest'],
      );
    case 'npm':
      return command(
        packageManager,
        ignoreScripts
          ? ['install', '-g', '--ignore-scripts', 'wrongstack@latest']
          : ['install', '-g', 'wrongstack@latest'],
      );
  }
}

function command(pm: PackageManager, args: string[]): UpdateCommand {
  const executable = process.platform === 'win32' && pm !== 'bun' ? `${pm}.cmd` : pm;
  return {
    executable,
    args,
    display: `${pm} ${args.join(' ')}`,
  };
}

function otherManagerCommands(
  selected: PackageManager,
  opts: { allowScripts: boolean } = { allowScripts: false },
): string {
  const commands = (['npm', 'pnpm', 'yarn', 'bun'] as const)
    .filter((pm) => pm !== selected)
    .map((pm) => `  ${buildUpdateCommand(pm, opts).display}`);
  return commands.length > 0 ? `\nOther package managers:\n${commands.join('\n')}\n` : '';
}

function installWarningSummary(output: string): string | null {
  if (!/allow-scripts|allowScripts/i.test(output)) return null;
  return (
    'Install completed, but npm reported blocked lifecycle scripts. If a native optional ' +
    'feature is missing, rerun the update with npm script approval for the named package.'
  );
}
