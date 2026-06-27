import type {
  Agent,
  Context,
  EventBus,
  ExtensionRegistry,
  PluginAPI,
  ProviderRegistry,
  SessionWriter,
  SlashCommandRegistry,
  ToolRegistry,
} from '@wrongstack/core';
import type { WrongStackPack } from './pack.js';

export interface RuntimeHost {
  agent: Agent;
  context: Context;
  events: EventBus;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  slashCommands: SlashCommandRegistry;
  session: SessionWriter;
  extensions?: ExtensionRegistry | undefined;
  shutdown(): Promise<void>;
}

export interface RuntimeHostParts {
  agent: Agent;
  context: Context;
  events: EventBus;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  slashCommands: SlashCommandRegistry;
  session: SessionWriter;
  extensions?: ExtensionRegistry | undefined;
  shutdown?: (() => void | Promise<void>) | undefined;
}

export function createRuntimeHostFromParts(parts: RuntimeHostParts): RuntimeHost {
  return {
    agent: parts.agent,
    context: parts.context,
    events: parts.events,
    tools: parts.tools,
    providers: parts.providers,
    slashCommands: parts.slashCommands,
    session: parts.session,
    extensions: parts.extensions,
    async shutdown() {
      await parts.shutdown?.();
    },
  };
}

export interface ApplyPackOptions {
  owner?: string | undefined;
  api?: PluginAPI | undefined;
}

export interface AppliedPack {
  pack: WrongStackPack;
  owner: string;
  teardown(): Promise<void>;
}

export async function applyWrongStackPack(
  host: Pick<RuntimeHost, 'tools' | 'providers' | 'slashCommands'> & {
    extensions?: ExtensionRegistry | undefined;
  },
  pack: WrongStackPack,
  opts: ApplyPackOptions = {},
): Promise<AppliedPack> {
  const owner = opts.owner ?? pack.name;
  const unregisterExtensions: Array<() => void> = [];

  // Track registered tool names, command names, and provider types so teardown
  // can reverse everything in registration order.
  const registeredToolNames: string[] = [];
  const registeredCommandNames: string[] = [];
  const registeredProviderTypes: string[] = [];

  if (pack.tools) {
    const tools = [...pack.tools];
    host.tools.registerAllOrThrow(tools, owner);
    for (const t of tools) registeredToolNames.push(t.name);
  }
  if (pack.providers) {
    const providers = [...pack.providers];
    host.providers.registerAll(providers);
    for (const p of providers) registeredProviderTypes.push(p.type);
  }
  if (pack.slashCommands) {
    const cmds = [...pack.slashCommands];
    host.slashCommands.registerAll(cmds, owner);
    for (const c of cmds) registeredCommandNames.push(c.name);
  }
  if (pack.extensions && host.extensions) {
    for (const ext of pack.extensions) {
      unregisterExtensions.push(host.extensions.register(ext));
    }
  }

  // If setup() throws after registration, roll back everything we registered above.
  // This makes applyWrongStackPack() transactional from the caller's perspective —
  // either the pack is fully applied or it is not.
  if (pack.setup) {
    if (!opts.api) {
      throw new Error(`Pack "${pack.name}" defines setup() but no PluginAPI was provided`);
    }
    try {
      await pack.setup(opts.api);
    } catch (setupErr) {
      // Roll back in reverse order: extensions first, then commands,
      // then tools, then providers. Extensions are unregistered before
      // tools/commands because extensions may depend on those capabilities;
      // tearing them down first avoids dangling refs.
      for (const unregister of unregisterExtensions.reverse()) {
        unregister();
      }
      for (const name of registeredCommandNames.reverse()) {
        host.slashCommands.unregister(name);
      }
      for (const name of registeredToolNames.reverse()) {
        host.tools.unregister(name);
      }
      for (const type of registeredProviderTypes.reverse()) {
        host.providers.unregister(type);
      }
      throw setupErr;
    }
  }

  return {
    pack,
    owner,
    async teardown() {
      for (const unregister of unregisterExtensions.reverse()) {
        unregister();
      }
      // Unregister commands, tools, and providers so the same pack can be
      // re-loaded cleanly without name/type conflicts.
      for (const name of registeredCommandNames.reverse()) {
        host.slashCommands.unregister(name);
      }
      for (const name of registeredToolNames.reverse()) {
        host.tools.unregister(name);
      }
      for (const type of registeredProviderTypes.reverse()) {
        host.providers.unregister(type);
      }
      if (pack.teardown) {
        if (!opts.api) {
          throw new Error(`Pack "${pack.name}" defines teardown() but no PluginAPI was provided`);
        }
        await pack.teardown(opts.api);
      }
    },
  };
}

export async function applyWrongStackPacks(
  host: Pick<RuntimeHost, 'tools' | 'providers' | 'slashCommands'> & {
    extensions?: ExtensionRegistry | undefined;
  },
  packs: readonly WrongStackPack[],
  opts: ApplyPackOptions = {},
): Promise<AppliedPack[]> {
  const applied: AppliedPack[] = [];
  try {
    for (const pack of packs) {
      applied.push(await applyWrongStackPack(host, pack, opts));
    }
    return applied;
  } catch (err) {
    // Roll back already-mounted packs. Surface teardown failures via
    // process.emitWarning so they don't mask the original error but
    // remain visible — a silent teardown failure can leave state
    // half-initialized in ways that make the next run fail mysteriously.
    for (const mounted of applied.reverse()) {
      await mounted.teardown().catch((teardownErr) => {
        const detail = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        process.emitWarning(
          `Pack teardown during error rollback failed: ${detail}`,
          'PackRollbackWarning',
        );
      });
    }
    throw err;
  }
}
