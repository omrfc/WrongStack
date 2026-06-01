/**
 * cron plugin — Schedules recurring tasks via beforeIteration extension hooks.
 *
 * Tools registered:
 * - cron_schedule: Schedule a recurring action
 * - cron_list: List all scheduled jobs
 * - cron_cancel: Cancel a scheduled job
 */
import type { Plugin } from '@wrongstack/core';

const API_VERSION = '^0.1.10';

interface CronJob {
  name: string;
  intervalMs: number;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string;
  runCount: number;
}

interface CronState {
  jobs: Map<string, CronJob>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  createdAt: string;
}

function formatNextRun(intervalMs: number): string {
  const ms = Number.isNaN(intervalMs) || intervalMs <= 0 ? 60_000 : intervalMs;
  return new Date(Date.now() + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'cron',
  version: '0.1.0',
  description: 'Schedules recurring tasks using beforeIteration/afterIteration extension hooks',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    maxConcurrentJobs: 5,
    timezone: 'UTC',
    persistSchedules: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      maxConcurrentJobs: { type: 'number', default: 5 },
      timezone: { type: 'string', default: 'UTC' },
      persistSchedules: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    const state: CronState = {
      jobs: new Map(),
      timers: new Map(),
      createdAt: new Date().toISOString(),
    };

    const maxConcurrent = (api.config.extensions?.['cron'] as Record<string, unknown>)?.['maxConcurrentJobs'] as number ?? 5;

    function scheduleNextRun(name: string): void {
      const job = state.jobs.get(name);
      if (!job || !job.enabled) return;

      const existing = state.timers.get(name);
      if (existing) clearTimeout(existing);

      const delay = Math.max(0, new Date(job.nextRun).getTime() - Date.now());
      const timer = setTimeout(() => {
        job.runCount++;
        job.lastRun = new Date().toISOString();
        job.nextRun = formatNextRun(job.intervalMs);

        // Emit custom event
        api.emitCustom('cron:job_fired', {
          name,
          action: job.action,
          runCount: job.runCount,
          ts: new Date().toISOString(),
        });

        api.metrics.counter('cron_job_fired', 1, { job: name });
        api.metrics.histogram('cron_job_interval_ms', job.intervalMs, { job: name });

        // Schedule next
        scheduleNextRun(name);
      }, delay);

      state.timers.set(name, timer);
    }

    function cancelJob(name: string): void {
      const timer = state.timers.get(name);
      if (timer) {
        clearTimeout(timer);
        state.timers.delete(name);
      }
      state.jobs.delete(name);
    }

    // Register a single extension covering before/after iteration hooks
    api.extensions.register({
      name: 'cron-iteration-hooks',
      owner: 'cron',
      beforeIteration: async (_ctx, _idx) => {
        const now = Date.now();
        let activeJobs = 0;
        const promises: Array<Promise<void>> = [];

        for (const [name, job] of state.jobs) {
          if (!job.enabled) continue;
          if (activeJobs >= maxConcurrent) break;

          if (new Date(job.nextRun).getTime() <= now) {
            activeJobs++;
            promises.push(
              (async () => {
                await api.session.append({
                  type: 'cron:scheduled_trigger',
                  ts: new Date().toISOString(),
                  jobName: name,
                  action: job.action,
                  runCount: job.runCount + 1,
                });
                api.emitCustom('cron:job_due', {
                  name,
                  action: job.action,
                  dueAt: new Date().toISOString(),
                });
              })(),
            );
          }
        }

        await Promise.all(promises);
      },
      afterIteration: async (_ctx, _idx) => {
        for (const job of state.jobs.values()) {
          if (!job.enabled) continue;
          if (new Date(job.nextRun).getTime() <= Date.now()) {
            job.nextRun = formatNextRun(job.intervalMs);
          }
        }
      },
    });

    // --- cron_schedule ---
    api.tools.register({
      name: 'cron_schedule',
      description: 'Schedule a recurring action to fire at a fixed interval (in milliseconds). The action is emitted as a custom event for downstream handlers.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for this cron job' },
          intervalMs: { type: 'number', description: 'Interval between runs in milliseconds (minimum 1000)' },
          action: { type: 'string', description: 'Action identifier or description of what to run' },
          enabled: { type: 'boolean', default: true },
        },
        required: ['name', 'intervalMs', 'action'],
      },
      permission: 'confirm',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const name = input['name'] as string;
        const intervalMs = Math.max(1000, Number(input['intervalMs']));
        const action = input['action'] as string;
        const enabled = (input['enabled'] as boolean | undefined) ?? true;

        if (!name || typeof name !== 'string' || name.trim() === '') {
          return { ok: false, error: 'name is required and must be a non-empty string' };
        }
        if (Number.isNaN(intervalMs)) {
          return { ok: false, error: 'intervalMs must be a number >= 1000' };
        }

        if (state.jobs.has(name)) {
          return { ok: false, error: `Cron job '${name}' already exists. Use cron_cancel first.` };
        }

        if (state.jobs.size >= maxConcurrent) {
          return { ok: false, error: `Maximum concurrent jobs (${maxConcurrent}) reached.` };
        }

        const job: CronJob = {
          name,
          intervalMs,
          action,
          enabled,
          lastRun: null,
          nextRun: formatNextRun(intervalMs),
          runCount: 0,
        };

        state.jobs.set(name, job);
        scheduleNextRun(name);

        api.metrics.gauge('cron_active_jobs', state.jobs.size);

        return {
          ok: true,
          name,
          intervalMs,
          nextRun: job.nextRun,
          message: `Scheduled '${name}' every ${intervalMs}ms.`,
        };
      },
    });

    // --- cron_list ---
    api.tools.register({
      name: 'cron_list',
      description: 'List all registered cron jobs with their intervals, next run times, and execution counts.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        const jobs = Array.from(state.jobs.values()).map((j) => ({
          name: j.name,
          intervalMs: j.intervalMs,
          action: j.action,
          enabled: j.enabled,
          lastRun: j.lastRun,
          nextRun: j.nextRun,
          runCount: j.runCount,
          overdue: new Date(j.nextRun).getTime() < Date.now(),
        }));

        return {
          ok: true,
          count: jobs.length,
          maxConcurrent,
          jobs,
        };
      },
    });

    // --- cron_cancel ---
    api.tools.register({
      name: 'cron_cancel',
      description: 'Cancel and remove a cron job by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the cron job to cancel' },
        },
        required: ['name'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const name = input['name'] as string;

        if (!state.jobs.has(name)) {
          return { ok: false, error: `No cron job named '${name}'` };
        }

        cancelJob(name);
        api.metrics.gauge('cron_active_jobs', state.jobs.size);

        return {
          ok: true,
          name,
          message: `Cancelled cron job '${name}'.`,
        };
      },
    });

    api.log.info('cron plugin loaded', { version: '0.1.0', maxConcurrent });
  },

  teardown(api) {
    const { jobs, timers } = (api as unknown as { _state?: CronState })._state ?? { jobs: new Map(), timers: new Map() };
    for (const name of jobs.keys()) {
      const timer = timers.get(name);
      if (timer) clearTimeout(timer);
    }
    jobs.clear();
    timers.clear();
    api.log.info('cron plugin unloaded');
  },
};

export default plugin;