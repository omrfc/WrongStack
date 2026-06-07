import {
  type ModelsRegistry,
  type ProviderConfig,
  type ResolvedProvider,
  type SecretVault,
  type WireFamily,
  color,
} from '@wrongstack/core';
import type { ReadlineInputReader } from './input-reader.js';
import {
  activeLabel,
  expectDefined,
  loadConfigProviders,
  maskedKey,
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from './provider-config-utils.js';
import type { TerminalRenderer } from './renderer.js';



export interface AuthMenuDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modelsRegistry: ModelsRegistry;
  vault: SecretVault;
  globalConfigPath: string;
}

/**
 * Interactive auth manager. Shows saved providers + keys, lets the user
 * add/update/delete keys, set the active key per provider, or add a key
 * for any provider in the models.dev catalog. Loops until the user exits.
 *
 * The legacy single-key `apiKey` field is migrated to `apiKeys[]` lazily
 * on first edit, so users who set up under the old schema upgrade
 * transparently the first time they open this menu.
 */
export async function runAuthMenu(deps: AuthMenuDeps): Promise<number> {
  for (;;) {
    const providers = await loadProviders(deps);
    renderTopMenu(deps.renderer, providers);

    const ids = Object.keys(providers).sort();
    const choice = (await deps.reader.readLine(`\n${color.amber('?')} Pick: `))
      .trim()
      .toLowerCase();

    if (!choice || choice === 'q' || choice === 'quit' || choice === 'exit') {
      deps.renderer.write(color.dim('Done.\n'));
      return 0;
    }

    if (choice === 'a' || choice === 'add') {
      await addForNewProvider(deps);
      continue;
    }

    if (choice === 'c' || choice === 'custom') {
      await addCustomProvider(deps);
      continue;
    }

    const idx = Number.parseInt(choice, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= ids.length) {
      const pid = expectDefined(ids[idx - 1]);
      await manageProvider(pid, deps);
      continue;
    }

    // Try matching by provider id directly.
    const byId = ids.find((id) => id.toLowerCase() === choice);
    if (byId) {
      await manageProvider(byId, deps);
      continue;
    }

    deps.renderer.writeError(`Unknown selection: "${choice}"`);
  }
}

function renderTopMenu(
  renderer: TerminalRenderer,
  providers: Record<string, ProviderConfig>,
): void {
  renderer.write(`\n${color.bold('WrongStack')} ${color.dim('— API keys')}\n\n`);
  const ids = Object.keys(providers).sort();
  if (ids.length === 0) {
    renderer.write(color.dim('  No providers configured yet.\n'));
  } else {
    renderer.write(`  ${color.dim('Saved providers:')}\n`);
    let idx = 1;
    for (const id of ids) {
      const cfg = providers[id];
      if (!cfg) continue;
      const keys = normalizeKeys(cfg);
      const active = activeLabel(cfg, keys);
      const firstKey = keys[0];
      const summary =
        keys.length === 0
          ? color.dim('(no keys)')
          : keys.length === 1
            ? maskedKey(firstKey?.apiKey ?? '')
            : `${color.dim(`${keys.length} keys`)} ${color.dim('active:')} ${color.bold(active ?? '?')} ${maskedKey(keys.find((k) => k.label === active)?.apiKey ?? firstKey?.apiKey ?? '')}`;
      const fam = cfg.family ? color.dim(`[${cfg.family}]`) : '';
      const aliasHint = cfg.type && cfg.type !== id ? color.dim(`→ ${cfg.type}`) : '';
      renderer.write(
        `    ${color.dim(`${idx}.`.padStart(4))} ${id.padEnd(22)} ${fam} ${aliasHint} ${summary}\n`,
      );
      idx++;
    }
  }
  renderer.write(`\n  ${color.dim('Actions:')}\n`);
  renderer.write(`    ${color.bold('a')}  Add key for a new provider (from catalog)\n`);
  renderer.write(`    ${color.bold('c')}  Add custom provider (type + family + baseUrl)\n`);
  renderer.write(`    ${color.bold('q')}  Quit\n`);
  if (ids.length > 0) {
    renderer.write(color.dim(`\n  Pick a number to manage that provider's keys.\n`));
  }
}

async function manageProvider(providerId: string, deps: AuthMenuDeps): Promise<void> {
  for (;;) {
    const providers = await loadProviders(deps);
    const cfg = providers[providerId];
    if (!cfg) {
      deps.renderer.writeError(`Provider "${providerId}" no longer in config.`);
      return;
    }
    const keys = normalizeKeys(cfg);
    const active = activeLabel(cfg, keys);

    deps.renderer.write(
      `\n${color.bold(providerId)} ${cfg.family ? color.dim(`[${cfg.family}]`) : color.amber('[no family]')}\n`,
    );
    deps.renderer.write(
      color.dim(`  type:    ${cfg.type ?? providerId}\n`) +
        color.dim(
          `  family:  ${cfg.family ?? '(unset → resolved from models.dev when type matches)'}\n`,
        ) +
        color.dim(`  baseUrl: ${cfg.baseUrl ?? '(unset → catalog default)'}\n`),
    );
    if (cfg.envVars && cfg.envVars.length > 0) {
      deps.renderer.write(color.dim(`  envVars: ${cfg.envVars.join(', ')}\n`));
    }
    if (cfg.models && cfg.models.length > 0) {
      deps.renderer.write(color.dim(`  models:  ${cfg.models.join(', ')}\n`));
    }
    if (keys.length === 0) {
      deps.renderer.write(color.dim('  (no keys saved)\n'));
    } else {
      for (let i = 0; i < keys.length; i++) {
        const k = expectDefined(keys[i]);
        const marker = k.label === active ? color.green('●') : color.dim('○');
        deps.renderer.write(
          `  ${color.dim(`${i + 1}.`.padStart(4))} ${marker} ${k.label.padEnd(20)} ${maskedKey(k.apiKey)}  ${color.dim(k.createdAt)}\n`,
        );
      }
    }

    deps.renderer.write(`\n  ${color.dim('Actions:')}\n`);
    deps.renderer.write(`    ${color.bold('a')}        Add another key\n`);
    if (keys.length > 0) {
      deps.renderer.write(`    ${color.bold('u')} <n>    Update key <n>\n`);
      deps.renderer.write(`    ${color.bold('d')} <n>    Delete key <n>\n`);
      deps.renderer.write(`    ${color.bold('s')} <n>    Set key <n> as active\n`);
    }
    deps.renderer.write(`    ${color.bold('f')}        Edit family\n`);
    deps.renderer.write(`    ${color.bold('B')}        Edit baseUrl\n`);
    deps.renderer.write(`    ${color.bold('m')}        Edit visible model list\n`);
    deps.renderer.write(`    ${color.bold('x')}        Remove this provider entirely\n`);
    deps.renderer.write(`    ${color.bold('b')}        Back\n`);
    deps.renderer.write(`    ${color.bold('q')}        Quit\n`);

    const raw = (await deps.reader.readLine(`\n${color.amber('?')} ${providerId} > `)).trim();
    if (!raw || raw === 'b' || raw === 'back' || raw === 'q' || raw === 'quit') return;

    const [verb, argRaw] = raw.split(/\s+/, 2);
    const arg = argRaw ? Number.parseInt(argRaw, 10) : Number.NaN;

    if (verb === 'a' || verb === 'add') {
      await addKeyForProvider(providerId, deps, cfg);
      continue;
    }
    if (verb === 'x' || verb === 'remove') {
      const confirm = (
        await deps.reader.readLine(
          `  ${color.amber('?')} Remove provider "${providerId}" and ${keys.length} key(s)? ${color.dim('[y/N/q]')} `,
        )
      )
        .trim()
        .toLowerCase();
      if (confirm === 'q') continue;
      if (confirm === 'y' || confirm === 'yes') {
        await mutateProviders(deps, (all) => {
          delete all[providerId];
        });
        deps.renderer.write(`  ${color.green('✓')} Removed ${providerId}.\n`);
        return;
      }
      continue;
    }
    if (verb === 'u' || verb === 'update') {
      if (!Number.isFinite(arg) || arg < 1 || arg > keys.length) {
        deps.renderer.writeError(`Usage: u <1-${keys.length}>`);
        continue;
      }
      const target = expectDefined(keys[arg - 1]);
      const newKey = await readKeyInput(deps, `Updated key for ${target.label}`);
      if (!newKey) continue;
      await mutateProviders(deps, (all) => {
        const p = all[providerId];
        if (!p) return;
        const list = normalizeKeys(p).map((k) =>
          k.label === target.label ? { ...k, apiKey: newKey, createdAt: nowIso() } : k,
        );
        writeKeysBack(p, list);
      });
      deps.renderer.write(`  ${color.green('✓')} Updated ${providerId}/${target.label}.\n`);
      continue;
    }
    if (verb === 'd' || verb === 'delete' || verb === 'rm') {
      if (!Number.isFinite(arg) || arg < 1 || arg > keys.length) {
        deps.renderer.writeError(`Usage: d <1-${keys.length}>`);
        continue;
      }
      const target = expectDefined(keys[arg - 1]);
      const confirm = (
        await deps.reader.readLine(
          `  ${color.amber('?')} Delete key "${target.label}" (${maskedKey(target.apiKey)})? ${color.dim('[y/N/q]')} `,
        )
      )
        .trim()
        .toLowerCase();
      if (confirm === 'q') continue;
      if (confirm !== 'y' && confirm !== 'yes') continue;
      await mutateProviders(deps, (all) => {
        const p = all[providerId];
        if (!p) return;
        const list = normalizeKeys(p).filter((k) => k.label !== target.label);
        writeKeysBack(p, list);
        if (p.activeKey === target.label) {
          p.activeKey = list[0]?.label;
        }
      });
      deps.renderer.write(`  ${color.green('✓')} Deleted ${providerId}/${target.label}.\n`);
      continue;
    }
    if (verb === 'f' || verb === 'family') {
      const current = cfg.family ?? '';
      const ans = (
        await deps.reader.readLine(
          `  ${color.amber('?')} Family ${color.dim(`(anthropic | openai | openai-compatible | google, empty = unset, current: ${current || 'unset'})`)}: `,
        )
      ).trim() as WireFamily | '';
      if (ans !== '' && !['anthropic', 'openai', 'openai-compatible', 'google'].includes(ans)) {
        deps.renderer.writeError(`Invalid family: "${ans}"`);
        continue;
      }
      await mutateProviders(deps, (all) => {
        const p = all[providerId];
        if (!p) return;
        if (ans === '') delete p.family;
        else p.family = ans;
      });
      deps.renderer.write(`  ${color.green('✓')} family → ${ans || '(unset)'}\n`);
      continue;
    }
    if (verb === 'B' || verb === 'baseurl' || verb === 'base-url') {
      const current = cfg.baseUrl ?? '';
      const ans = (
        await deps.reader.readLine(
          `  ${color.amber('?')} Base URL ${color.dim(`(empty = unset, current: ${current || 'unset'})`)}: `,
        )
      ).trim();
      await mutateProviders(deps, (all) => {
        const p = all[providerId];
        if (!p) return;
        if (ans === '') delete p.baseUrl;
        else p.baseUrl = ans;
      });
      deps.renderer.write(`  ${color.green('✓')} baseUrl → ${ans || '(unset)'}\n`);
      continue;
    }
    if (verb === 'm' || verb === 'models') {
      const current = (cfg.models ?? []).join(', ');
      const ans = (
        await deps.reader.readLine(
          `  ${color.amber('?')} Model ids ${color.dim(`(comma-separated, empty = catalog default, current: ${current || 'none'})`)}: `,
        )
      ).trim();
      const list = ans
        ? ans
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      await mutateProviders(deps, (all) => {
        const p = all[providerId];
        if (!p) return;
        if (list.length === 0) delete p.models;
        else p.models = list;
      });
      deps.renderer.write(
        `  ${color.green('✓')} models → ${list.length === 0 ? '(catalog default)' : list.join(', ')}\n`,
      );
      continue;
    }
    if (verb === 's' || verb === 'set' || verb === 'active') {
      if (!Number.isFinite(arg) || arg < 1 || arg > keys.length) {
        deps.renderer.writeError(`Usage: s <1-${keys.length}>`);
        continue;
      }
      const target = expectDefined(keys[arg - 1]);
      await mutateProviders(deps, (all) => {
        const p = all[providerId];
        if (!p) return;
        // Make sure the apiKeys[] form is canonical before flipping active.
        const list = normalizeKeys(p);
        writeKeysBack(p, list);
        p.activeKey = target.label;
      });
      deps.renderer.write(
        `  ${color.green('✓')} Active key for ${providerId} → ${color.bold(target.label)}.\n`,
      );
      continue;
    }
    deps.renderer.writeError(`Unknown action: "${raw}"`);
  }
}

/**
 * Pick a provider from the models.dev catalog (grouped by family) and add
 * a key for it. Catalog lookup populates family/baseUrl/envVars defaults.
 * When the catalog is unavailable we still let the user type a provider
 * id and family manually so the offline path keeps working.
 */
async function addForNewProvider(deps: AuthMenuDeps): Promise<void> {
  let catalog: ResolvedProvider[] = [];
  try {
    catalog = (await deps.modelsRegistry.listProviders()).filter((p) => p.family !== 'unsupported');
  } catch {
    deps.renderer.writeWarning('Catalog unavailable — falling back to manual entry.');
  }

  if (catalog.length === 0) {
    // Manual entry path
    const pid = (await deps.reader.readLine(`  ${color.amber('?')} Provider id ${color.dim('[q to quit]')}: `)).trim();
    if (!pid || pid === 'q') return;
    const fam = (
      await deps.reader.readLine(
        `  ${color.amber('?')} Family (anthropic/openai/openai-compatible/google): `,
      )
    ).trim() as WireFamily;
    const baseUrl = (
      await deps.reader.readLine(`  ${color.amber('?')} Base URL ${color.dim('(optional)')}: `)
    ).trim();
    await addKeyForProvider(pid, deps, {
      type: pid,
      family: fam || undefined,
      ...(baseUrl ? { baseUrl } : {}),
    });
    return;
  }

  // Group catalog by family, optionally narrowed by a substring filter
  // and/or hiding already-saved entries. The catalog has 120+ entries —
  // without a filter the openai-compatible list alone scrolls off-screen,
  // so types like "zai-coding-plan" get easy to miss.
  const saved = new Set(Object.keys(await loadProviders(deps)));
  deps.renderer.write(
    color.dim(
      `  Catalog has ${catalog.length} providers. Filter by name to narrow, or "s" for unsaved-only.\n`,
    ),
  );
  const filterRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Filter ${color.dim('(substring, "s" for unsaved-only, q to quit)')}: `,
    )
  ).trim();
  if (filterRaw === 'q') return;
  const filterLc = filterRaw.toLowerCase();
  const showUnsavedOnly = filterLc === 's' || filterLc === 'unsaved';
  const matches = (p: ResolvedProvider): boolean => {
    if (showUnsavedOnly) return !saved.has(p.id);
    if (!filterLc) return true;
    return p.id.toLowerCase().includes(filterLc) || p.name.toLowerCase().includes(filterLc);
  };

  const byFamily = new Map<WireFamily, ResolvedProvider[]>();
  let filteredCount = 0;
  for (const p of catalog) {
    if (!matches(p)) continue;
    filteredCount++;
    const list = byFamily.get(p.family) ?? [];
    list.push(p);
    byFamily.set(p.family, list);
  }

  if (filteredCount === 0) {
    deps.renderer.writeError(
      `No providers match "${filterRaw}". Try a shorter substring or check \`wstack providers\` for valid ids.`,
    );
    return;
  }
  if (filterRaw && !showUnsavedOnly) {
    deps.renderer.write(
      color.dim(`  ${filteredCount} match${filteredCount === 1 ? '' : 'es'} for "${filterRaw}".\n`),
    );
  }

  const ordered: ResolvedProvider[] = [];
  const familyOrder: WireFamily[] = ['anthropic', 'openai', 'google', 'openai-compatible'];
  let idx = 1;
  deps.renderer.write('\n');
  for (const fam of familyOrder) {
    const list = byFamily.get(fam);
    if (!list || list.length === 0) continue;
    deps.renderer.write(`  ${color.bold(fam)}\n`);
    for (const p of list) {
      const savedMark = saved.has(p.id) ? color.cyan('◉') : color.dim('○');
      const env = p.envVars[0] ? color.dim(`[${p.envVars[0]}]`) : '';
      deps.renderer.write(
        `    ${color.dim(`${idx}.`.padStart(4))} ${savedMark} ${p.id.padEnd(22)} ${color.dim(p.name)} ${env}\n`,
      );
      ordered.push(p);
      idx++;
    }
  }
  deps.renderer.write(`\n  ${color.dim('◉ already saved   ○ no key yet')}\n`);

  const answer = (
    await deps.reader.readLine(
      `\n${color.amber('?')} Pick (1-${ordered.length}) or type provider id ${color.dim('[q to quit]')}: `,
    )
  ).trim();
  if (!answer || answer === 'q') return;

  let chosen: ResolvedProvider | undefined;
  const num = Number.parseInt(answer, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= ordered.length) {
    chosen = ordered[num - 1];
  } else {
    chosen =
      ordered.find((p) => p.id.toLowerCase() === answer.toLowerCase()) ??
      catalog.find((p) => p.id.toLowerCase() === answer.toLowerCase());
  }
  if (!chosen) {
    deps.renderer.writeError(`No such provider: "${answer}"`);
    return;
  }

  // Always show family + baseUrl as inline prompts with catalog defaults
  // so the user can override either one without a separate confirmation
  // step. Press Enter to accept the catalog value, or type a new one to
  // change it. Useful for routing a catalog-known id through a custom
  // proxy or a different wire family (e.g. "anthropic"-id provider
  // through an openai-compatible gateway).
  deps.renderer.write(
    color.dim(`\n  Defaults from models.dev — press Enter to keep, or type a new value.\n`),
  );
  const famRaw = (
    await deps.reader.readLine(`  ${color.amber('?')} Family ${color.dim(`[${chosen.family}]`)} ${color.dim('(q to quit)')}: `)
  ).trim();
  if (famRaw === 'q') return;
  let family: WireFamily = chosen.family;
  if (famRaw) {
    if (!['anthropic', 'openai', 'openai-compatible', 'google'].includes(famRaw)) {
      deps.renderer.writeError(
        `Invalid family: "${famRaw}" (must be anthropic | openai | openai-compatible | google).`,
      );
      return;
    }
    family = famRaw as WireFamily;
  }
  const baseRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Base URL ${color.dim(`[${chosen.apiBase ?? 'unset'}]`)} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (baseRaw === 'q') return;
  const baseUrl: string | undefined = baseRaw || chosen.apiBase;

  // Pick the storage alias (= map key under `providers`). Two reasons to
  // make this distinct from the catalog id:
  //   1. The user may want the SAME catalog provider saved twice with
  //      different family/baseUrl (e.g. zai-coding-plan once as
  //      openai-compatible, once as anthropic) — different aliases let
  //      both entries coexist.
  //   2. The CLI launches via `--provider <alias>`, so a short custom
  //      name like "zai-claude" is friendlier than "zai-coding-plan-anthropic".
  // Auto-suggest a disambiguated alias when family diverges from the
  // catalog default, since that's the signal the user is creating a
  // second variant — not just adding another key to the same profile.
  const providersNow = await loadProviders(deps);
  let suggestedAlias = chosen.id;
  if (family !== chosen.family) {
    let candidate = `${chosen.id}-${family}`;
    let n = 2;
    while (providersNow[candidate]) {
      candidate = `${chosen.id}-${family}-${n}`;
      n++;
    }
    suggestedAlias = candidate;
  }
  const aliasRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Save under alias ${color.dim(`[${suggestedAlias}]`)} ${color.dim('(used as `--provider <alias>`)')}: `,
    )
  ).trim();
  const alias = aliasRaw || suggestedAlias;

  // Block clobbering an unrelated existing entry. Same alias is fine if
  // the user is intentionally adding another KEY to the same profile —
  // but only when family + baseUrl match what's already saved. Otherwise
  // we'd silently overwrite their settings and pile a key into the wrong
  // place (exactly the bug that motivated the alias prompt).
  const existing = providersNow[alias];
  if (existing) {
    const sameFamily = (existing.family ?? chosen.family) === family;
    const sameBase = (existing.baseUrl ?? chosen.apiBase) === baseUrl;
    if (!sameFamily || !sameBase) {
      deps.renderer.writeError(
        `Alias "${alias}" already exists with different family/baseUrl.\n  ` +
          `Existing: family=${existing.family ?? '(unset)'}, baseUrl=${existing.baseUrl ?? '(unset)'}\n  ` +
          `New:      family=${family}, baseUrl=${baseUrl ?? '(unset)'}\n  ` +
          `Pick a different alias to keep them separate.`,
      );
      return;
    }
  }

  await addKeyForProvider(alias, deps, {
    type: chosen.id,
    family,
    baseUrl,
    envVars: chosen.envVars,
  });
}

/**
 * Add a fully user-defined provider that bypasses the models.dev catalog.
 * The user picks the type (registry id), wire family, and base URL — all
 * three are stored on the entry so the CLI can construct the provider
 * via `makeProviderFromConfig` at boot without a catalog lookup.
 */
async function addCustomProvider(deps: AuthMenuDeps): Promise<void> {
  deps.renderer.write(
    `\n${color.bold('Custom provider')} ${color.dim('— for local models or proxies not in the models.dev catalog.')}\n`,
  );
  const type = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Provider id ${color.dim('(e.g. "local-llama", "my-proxy", q to quit)')}: `,
    )
  ).trim();
  if (!type || type === 'q') return;

  const existing = (await loadProviders(deps))[type];
  if (existing) {
    deps.renderer.writeWarning(`"${type}" already exists. Pick it from the main menu to edit.`);
    return;
  }

  const familyRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Wire family ${color.dim('(anthropic | openai | openai-compatible | google)')} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (familyRaw === 'q') return;
  if (!['anthropic', 'openai', 'openai-compatible', 'google'].includes(familyRaw)) {
    deps.renderer.writeError(`Invalid family: "${familyRaw}"`);
    return;
  }
  const family = familyRaw as WireFamily;

  const baseUrl = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Base URL ${color.dim('(e.g. http://localhost:11434/v1, leave empty if not needed)')}: `,
    )
  ).trim();

  const modelsRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Model ids ${color.dim('(comma-separated, optional)')}: `,
    )
  ).trim();
  const models = modelsRaw
    ? modelsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const envVarsRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Env var names ${color.dim('(comma-separated, optional fallback for the key)')}: `,
    )
  ).trim();
  const envVars = envVarsRaw
    ? envVarsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  await addKeyForProvider(type, deps, {
    type,
    family,
    ...(baseUrl ? { baseUrl } : {}),
    ...(models ? { models } : {}),
    ...(envVars ? { envVars } : {}),
  });
}

async function addKeyForProvider(
  providerId: string,
  deps: AuthMenuDeps,
  template: Partial<ProviderConfig>,
): Promise<void> {
  const providers = await loadProviders(deps);
  const existing = providers[providerId];
  const existingKeys = existing ? normalizeKeys(existing) : [];
  const usedLabels = new Set(existingKeys.map((k) => k.label));

  // Suggest a sensible default label
  let defaultLabel = 'default';
  if (usedLabels.has(defaultLabel)) {
    let n = 2;
    while (usedLabels.has(`key${n}`)) n++;
    defaultLabel = `key${n}`;
  }

  const labelRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Label for this key ${color.dim(`[${defaultLabel}]`)}: `,
    )
  ).trim();
  const label = labelRaw || defaultLabel;
  if (usedLabels.has(label)) {
    deps.renderer.writeError(
      `Label "${label}" already used for ${providerId}. Use update (u) instead.`,
    );
    return;
  }

  const apiKey = await readKeyInput(deps, `API key for ${providerId}/${label}`);
  if (!apiKey) {
    deps.renderer.writeError('No key entered. Nothing saved.');
    return;
  }

  await mutateProviders(deps, (all) => {
    const existingProv = all[providerId] ?? { type: providerId, ...template };
    // Backfill type/family/baseUrl from template when absent.
    if (!existingProv.type) existingProv.type = providerId;
    if (!existingProv.family && template.family) existingProv.family = template.family;
    if (!existingProv.baseUrl && template.baseUrl) existingProv.baseUrl = template.baseUrl;
    if (!existingProv.envVars && template.envVars) existingProv.envVars = template.envVars;
    const list = normalizeKeys(existingProv);
    list.push({ label, apiKey, createdAt: nowIso() });
    writeKeysBack(existingProv, list);
    if (!existingProv.activeKey) existingProv.activeKey = label;
    all[providerId] = existingProv;
  });

  deps.renderer.write(
    `  ${color.green('✓')} Saved ${color.bold(providerId)}/${color.bold(label)}. ${color.dim('Use `wstack --provider ' + providerId + ' "<task>"` to launch.')}\n`,
  );
}

/**
 * One-shot add: used by `wstack auth <provider>` to skip the menu and
 * append a single key. Honors --label / --family / --base-url / --env
 * flags. If the label collides, we suffix with a counter.
 */
export async function runAuthDirect(
  deps: AuthMenuDeps,
  opts: {
    providerId: string;
    label?: string | undefined;
    family?: WireFamily | undefined;
    baseUrl?: string | undefined;
    envVars?: string[] | undefined;
  },
): Promise<number> {
  const { providerId } = opts;
  const providers = await loadProviders(deps);
  const existing = providers[providerId];

  if (!existing && !opts.family) {
    // Try the catalog before giving up.
    let knownFamily: WireFamily | undefined;
    let knownBase: string | undefined;
    let knownEnv: string[] | undefined;
    try {
      const k = await deps.modelsRegistry.getProvider(providerId);
      if (k) {
        knownFamily = k.family;
        knownBase = k.apiBase;
        knownEnv = k.envVars;
      }
    } catch {
      // catalog unavailable
    }
    if (!knownFamily || knownFamily === 'unsupported') {
      deps.renderer.writeError(
        `Provider "${providerId}" not in catalog. Pass --family <anthropic|openai|openai-compatible|google>.`,
      );
      return 1;
    }
    opts.family = knownFamily;
    opts.baseUrl ??= knownBase;
    opts.envVars ??= knownEnv;
  }

  const usedLabels = new Set(existing ? normalizeKeys(existing).map((k) => k.label) : []);
  let label = opts.label ?? 'default';
  if (usedLabels.has(label)) {
    let n = 2;
    while (usedLabels.has(`${label}-${n}`)) n++;
    label = `${label}-${n}`;
    deps.renderer.writeInfo(`Label collided; saving as "${label}".`);
  }

  const apiKey = await readKeyInput(deps, `API key for ${providerId}/${label}`);
  if (!apiKey) return 1;

  await mutateProviders(deps, (all) => {
    const p = all[providerId] ?? { type: providerId };
    if (!p.type) p.type = providerId;
    if (!p.family && opts.family) p.family = opts.family;
    if (!p.baseUrl && opts.baseUrl) p.baseUrl = opts.baseUrl;
    if (!p.envVars && opts.envVars) p.envVars = opts.envVars;
    const list = normalizeKeys(p);
    list.push({ label, apiKey, createdAt: nowIso() });
    writeKeysBack(p, list);
    if (!p.activeKey) p.activeKey = label;
    all[providerId] = p;
  });

  deps.renderer.writeInfo(`Stored encrypted key for ${providerId} (label "${label}").`);
  deps.renderer.writeInfo(`Use: wstack --provider ${providerId} "<task>"`);
  return 0;
}

async function readKeyInput(deps: AuthMenuDeps, intent: string): Promise<string | undefined> {
  const key = (
    await deps.reader.readSecret(
      `  ${color.amber('?')} ${intent} ${color.dim('(hidden, paste OK)')}: `,
    )
  ).trim();
  if (!key) {
    deps.renderer.writeError('No key entered.');
    return undefined;
  }
  return key;
}

/* ----------------------------- I/O helpers ----------------------------- */

/** Thin wrapper — delegates to the shared config provider loader. */
function loadProviders(deps: AuthMenuDeps): Promise<Record<string, ProviderConfig>> {
  return loadConfigProviders(deps.globalConfigPath, deps.vault, {
    warn: (msg) => deps.renderer.writeWarning(msg),
  });
}

/** Thin wrapper — delegates to the shared atomic config mutator. */
function mutateProviders(
  deps: AuthMenuDeps,
  mutator: (providers: Record<string, ProviderConfig>) => void,
): Promise<void> {
  return mutateConfigProviders(deps.globalConfigPath, deps.vault, mutator);
}
