const WIN32_CMD_META = /[&|<>"\r\n\0]/;

export interface Win32CmdShimInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: true;
}

export function buildWin32CmdShimInvocation(
  command: string,
  args: readonly string[] = [],
): Win32CmdShimInvocation {
  assertSafeWin32CmdArgs([command, ...args]);
  const line = ['call', quoteWin32CmdArg(command), ...args.map(quoteWin32CmdArg)].join(' ');
  return {
    command: process.env['COMSPEC'] ?? 'cmd.exe',
    args: ['/d', '/c', line],
    windowsVerbatimArguments: true,
  };
}

function assertSafeWin32CmdArgs(args: readonly unknown[]): void {
  for (const arg of args) {
    if (typeof arg === 'string' && WIN32_CMD_META.test(arg)) {
      throw new Error(
        'win32 cmd shim spawn: argument contains a shell metacharacter ' +
          '(one of & | < > ", or a newline) that could enable command injection ' +
          'through the .cmd/.bat wrapper - refusing to run. Offending argument: ' +
          JSON.stringify(arg),
      );
    }
  }
}

function quoteWin32CmdArg(arg: string): string {
  return `"${arg}"`;
}
