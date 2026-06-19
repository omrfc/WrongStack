/**
 * Well-known tool capabilities used for authorization decisions.
 *
 * These are the preferred values for `Tool.capabilities`.
 * New capabilities should be added here with clear documentation.
 *
 * Philosophy (2026-06+):
 * - Prefer capabilities over exact tool name matching.
 * - Subagent guards and future policies should primarily key off capabilities.
 * - Name-based denylists are legacy and will be phased down.
 */
export const ToolCapabilities = {
  /** Can execute arbitrary commands in the user's shell (the `bash` tool). */
  SHELL_ARBITRARY: 'shell.arbitrary',

  /** Can execute a restricted set of commands (the `exec` tool). */
  SHELL_RESTRICTED: 'shell.restricted',

  /** Can read files inside the project (and possibly outside via symlinks if not guarded). */
  FS_READ: 'fs.read',

  /** Can write / modify / delete files inside the project. */
  FS_WRITE: 'fs.write',

  /** Can write files outside the current project root (very high risk). */
  FS_WRITE_OUTSIDE_PROJECT: 'fs.write.outside-project',

  /** Can perform outbound network requests. */
  NET_OUTBOUND: 'net.outbound',

  /** Proxies tools from external MCP servers (unknown capability). */
  MCP_PROXY: 'mcp.proxy',

  /** Can spawn or manage subagents / multi-agent tasks. */
  SUBAGENT_SPAWN: 'subagent.spawn',

  /** Can mutate global or session configuration / trust state. */
  CONFIG_MUTATE: 'config.mutate',

  /** Can install packages or run package managers with side effects. */
  PACKAGE_INSTALL: 'package.install',
} as const;

export type ToolCapability = (typeof ToolCapabilities)[keyof typeof ToolCapabilities];

/**
 * Set of capabilities that are considered dangerous for subagents by default.
 * Subagents should not receive these capabilities unless the leader explicitly
 * allows the specific tool at spawn time.
 */
export const DANGEROUS_FOR_SUBAGENTS: readonly ToolCapability[] = [
  ToolCapabilities.SHELL_ARBITRARY,
  ToolCapabilities.SHELL_RESTRICTED,
  ToolCapabilities.FS_WRITE,
  ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
  ToolCapabilities.MCP_PROXY,
  ToolCapabilities.SUBAGENT_SPAWN,
  ToolCapabilities.CONFIG_MUTATE,
  ToolCapabilities.PACKAGE_INSTALL,
];

/**
 * Wide capability allowlist for subagents that the user has authorized to act
 * with full developer power (the CLI fleet host applies this to any subagent
 * that isn't given an explicit, narrower grant). It covers everything needed to
 * do real work end-to-end — read, write/edit inside the project, outbound
 * network, and shell/build/install — so a delegated coding or build agent runs
 * the same toolchain the leader would, without per-tool confirmation it cannot
 * answer.
 *
 * Deliberately EXCLUDED (require an explicit per-spawn `allowedCapabilities`
 * grant, because they escape the task's blast radius rather than perform it):
 *   - `fs.write.outside-project` — writing outside the repo (e.g. ~/.ssh).
 *   - `mcp.proxy` — third-party MCP tools (also hard-blocked by name).
 *   - `subagent.spawn` — recursive delegation (the baseline prompt forbids it).
 *   - `config.mutate` — rewriting trust/config is privilege escalation, not work.
 */
export const WIDE_SUBAGENT_CAPABILITIES: readonly ToolCapability[] = [
  ToolCapabilities.FS_READ,
  ToolCapabilities.FS_WRITE,
  ToolCapabilities.NET_OUTBOUND,
  ToolCapabilities.SHELL_ARBITRARY,
  ToolCapabilities.SHELL_RESTRICTED,
  ToolCapabilities.PACKAGE_INSTALL,
];

/**
 * Check if a tool (or its capabilities array) includes any dangerous capability
 * for subagent execution.
 */
export function hasDangerousCapabilityForSubagents(
  toolOrCaps: { capabilities?: readonly string[] | undefined } | readonly string[] | undefined,
): boolean {
  if (!toolOrCaps) return false;
  // Use `as unknown as ...` to allow accessing .capabilities on the union type
  const input = toolOrCaps as unknown as { capabilities?: readonly string[] | undefined };
  const caps: readonly string[] = Array.isArray(toolOrCaps) ? toolOrCaps : (input.capabilities ?? []);
  return caps.some((c) => DANGEROUS_FOR_SUBAGENTS.includes(c as ToolCapability));
}

/**
 * Check if a tool declares a specific capability (or any of the provided ones).
 */
export function hasCapability(
  toolOrCaps: { capabilities?: readonly string[] | undefined } | readonly string[] | undefined,
  capability: ToolCapability | ToolCapability[],
): boolean {
  if (!toolOrCaps) return false;
  // Use `as unknown as ...` to allow accessing .capabilities on the union type
  const input = toolOrCaps as unknown as { capabilities?: readonly string[] | undefined };
  const caps: readonly string[] = Array.isArray(toolOrCaps) ? toolOrCaps : (input.capabilities ?? []);
  const toCheck = Array.isArray(capability) ? capability : [capability];
  return toCheck.some((c) => caps.includes(c));
}

/**
 * Returns the intersection of a tool's capabilities with the dangerous set.
 * Useful for logging and audit trails.
 */
export function getDangerousCapabilities(
  toolOrCaps: { capabilities?: readonly string[] | undefined } | readonly string[] | undefined,
): ToolCapability[] {
  if (!toolOrCaps) return [];
  // Use `as unknown as ...` to allow accessing .capabilities on the union type
  const input = toolOrCaps as unknown as { capabilities?: readonly string[] | undefined };
  const caps: readonly string[] = Array.isArray(toolOrCaps) ? toolOrCaps : (input.capabilities ?? []);
  return caps.filter((c): c is ToolCapability =>
    DANGEROUS_FOR_SUBAGENTS.includes(c as ToolCapability),
  );
}
