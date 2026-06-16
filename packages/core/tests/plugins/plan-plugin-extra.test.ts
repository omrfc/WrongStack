import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanCommand, createPlanPlugin } from '../../src/plugins/plan-plugin.js';
import type { SlashCommand } from '../../src/index.js';

let tmp: string;
let planPath: string;
let taskPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-plugin-extra-'));
  planPath = path.join(tmp, 'plan.json');
  taskPath = path.join(tmp, 'tasks.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const ctx = (over: Record<string, unknown> = {}) =>
  ({ session: { id: 'sess-x' }, meta: {}, state: { replaceTodos: vi.fn() }, ...over }) as never;

describe('createPlanPlugin lifecycle', () => {
  function makeApi(config: Record<string, unknown> = {}) {
    const registered: SlashCommand[] = [];
    const unregister = vi.fn();
    const api = { config, slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister }, log: { info: vi.fn() } } as never;
    return { api, registered, unregister };
  }

  it('registers /plan on setup, unregisters on teardown, health ok', async () => {
    const { api, registered, unregister } = makeApi();
    const plugin = createPlanPlugin({ paths: { projectPlan: planPath } as never });
    plugin.setup!(api);
    expect(registered[0]?.name).toBe('plan');
    plugin.teardown!(api);
    expect(unregister).toHaveBeenCalledWith('plan');
    expect(await plugin.health!()).toMatchObject({ ok: true });
  });

  it('reads paths from api.config when no opts given (and reports unconfigured storage)', async () => {
    const { api, registered } = makeApi({}); // no paths → command built with undefined planPath
    createPlanPlugin().setup!(api);
    expect((await registered[0]!.run!('show', ctx())).message).toContain('not configured');
  });
});

describe('/plan taskify (findPlanItemIndex paths)', () => {
  it('usage, no-match, missing task storage, and success by index/id/title', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run!('add First strategic item', ctx());
    await cmd.run!('add Second item', ctx());

    expect((await cmd.run!('taskify', ctx())).message).toContain('Usage');
    expect((await cmd.run!('taskify zzz-nope', ctx())).message).toContain('No plan item matched');
    // taskify against a brand-new (never-saved) plan → loadPlan() is null → emptyPlan()
    expect((await buildPlanCommand(path.join(tmp, 'fresh.json')).run!('taskify 1', ctx())).message).toContain('No plan item matched');
    // no task.path in meta
    expect((await cmd.run!('taskify 1', ctx({ meta: {} }))).message).toContain('Task storage is not configured');

    // success by 1-based index
    const byIndex = await cmd.run!('taskify 1', ctx({ meta: { 'task.path': taskPath } }));
    expect(byIndex.message).toContain('Taskified "First strategic item"');
    expect(JSON.parse(await fs.readFile(taskPath, 'utf8')).tasks).toHaveLength(1);

    // success by title substring
    const byTitle = await cmd.run!('taskify second', ctx({ meta: { 'task.path': taskPath } }));
    expect(byTitle.message).toContain('Taskified "Second item"');

    // success by exact id
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    const id = plan.items[0].id;
    const byId = await cmd.run!(`taskify ${id}`, ctx({ meta: { 'task.path': taskPath } }));
    expect(byId.message).toContain('Taskified');
  });
});

describe('/plan promote, derive, done, template use', () => {
  it('promote replaces todos with derived subtasks', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run!('add Build the API', ctx());
    const c = ctx();
    const res = await cmd.run!('promote 1 design implement test', c);
    expect(res.message).toContain('Promoted to');
    expect((c as { state: { replaceTodos: ReturnType<typeof vi.fn> } }).state.replaceTodos).toHaveBeenCalled();
  });

  it('derive without subtasks, and a non-matching target', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run!('add Some work', ctx());
    expect((await cmd.run!('derive 1', ctx())).message).toContain('Derived');
    expect((await cmd.run!('promote', ctx())).message).toContain('Usage'); // no target
    expect((await cmd.run!('derive 99', ctx())).message).toContain('No plan item matched');
  });

  it('start/done/remove report usage with no argument', async () => {
    const cmd = buildPlanCommand(planPath);
    expect((await cmd.run!('start', ctx())).message).toContain('Usage');
    expect((await cmd.run!('done', ctx())).message).toContain('Usage');
    expect((await cmd.run!('remove', ctx())).message).toContain('Usage');
  });

  it('done marks an item complete by index', async () => {
    const cmd = buildPlanCommand(planPath);
    await cmd.run!('add Finish me', ctx());
    const res = await cmd.run!('done 1', ctx());
    expect(typeof res.message).toBe('string');
  });

  it('template use applies a known template and rejects unknown / missing names', async () => {
    const cmd = buildPlanCommand(planPath);
    expect((await cmd.run!('template use new-feature', ctx())).message).toContain('Applied template');
    expect((await cmd.run!('template use', ctx())).message).toContain('Usage');
    expect((await cmd.run!('template use bogus-name', ctx())).message).toContain('Unknown template');
    expect((await cmd.run!('template frobnicate', ctx())).message).toContain('Unknown template subcommand');
  });

  it('unknown verb reports the available subcommands', async () => {
    expect((await buildPlanCommand(planPath).run!('xyzzy', ctx())).message).toContain('Unknown subcommand');
  });
});
