'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import {
  Boxes,
  Infinity as InfinityIcon,
  Layers,
  ListChecks,
  Plug,
  ShieldCheck,
  Target,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';

const features = [
  {
    icon: InfinityIcon,
    title: 'Autonomy engine',
    tag: 'eternal · parallel',
    body: 'Two goal-driven loops launched via /autonomy. Eternal runs decide → execute → reflect against a persistent goal; parallel fans the goal out across N subagents per tick.',
  },
  {
    icon: Users,
    title: 'Multi-agent fleet',
    tag: 'Director + 47 roles',
    body: 'A Director promotes the session and drives a fleet through 14 orchestration tools — spawn, assign, await, ask, roll_up, health, transcripts, and collab debug. A smart dispatcher routes each task to the best-matching role.',
  },
  {
    icon: Target,
    title: 'Goal system',
    tag: '/goal — locked in',
    body: '/goal persists to goal.json and injects a full-autonomy preamble. Pause and resume without losing work — the engine exits gracefully after the current iteration.',
  },
  {
    icon: Wrench,
    title: '36 built-in tools',
    tag: 'no plugin required',
    body: 'Files, shell, web, git, lint/format/typecheck/test, package audits, a SQLite codebase index, and meta-tooling — all registered out of the box behind per-tool permissions.',
  },
  {
    icon: ShieldCheck,
    title: 'Permissions & secrets',
    tag: 'AES-256-GCM',
    body: 'Per-tool allow/deny policy persisted to trust.json and inherited by subagents. API keys are encrypted at rest with a per-machine key. YOLO auto-approves normal project work for trusted sessions.',
  },
  {
    icon: Boxes,
    title: '~110 providers',
    tag: 'boot-refreshed catalog',
    body: 'Four wire families with real end-to-end streaming. The models.dev catalog refreshes before boot completes, then the TUI model picker and capability resolver use the fresh provider data.',
  },
  {
    icon: ListChecks,
    title: 'Spec-Driven Development',
    tag: '/sdd',
    body: 'Point /sdd at a markdown spec and it runs parse → analyze → generate → track → execute, turning the spec into tracked tasks the agent works through.',
  },
  {
    icon: Workflow,
    title: 'AutoPhase',
    tag: '0.9.x',
    body: '/autophase breaks a project into ordered phases — Discovery, Design, Implementation, Testing, Deployment — and runs them autonomously with a live phase view in the web UI.',
  },
  {
    icon: Layers,
    title: 'Structured task system',
    tag: 'plan → task → todo',
    body: 'Three-layer work hierarchy. Plans outline strategy, tasks break work into typed/prioritized items with dependencies and agent assignment, todos track the immediate next step. Promote down the chain as work progresses.',
  },
  {
    icon: Plug,
    title: 'MCP integration',
    tag: 'stdio · SSE · HTTP',
    body: 'JSON-RPC 2.0 over three transports. Tools are namespaced mcp__<server>__<tool>; reconnect uses exponential backoff with jitter, capped before failing cleanly.',
  },
];

export function Features() {
  return (
    <section id="features" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="What it does"
          title="An agent loop with the"
          highlight="whole stack behind it"
          description="WrongStack is more than a prompt box. It is an autonomous coding runtime — fleets, goals, phases, and a kernel small enough to read in an afternoon."
        />

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.06}>
              <SpotlightCard className="h-full bg-card p-7 transition-colors hover:bg-surface">
                <div className="flex items-center justify-between">
                  <span className="grid size-11 place-items-center rounded-xl border border-line bg-surface text-brand transition-colors group-hover:border-brand/40">
                    <f.icon className="size-5" />
                  </span>
                  <span className="font-mono text-[11px] text-faint">{f.tag}</span>
                </div>
                <h3 className="mt-5 text-lg font-bold tracking-tight">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
