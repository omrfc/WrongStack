'use client';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy';
import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { META } from '@/lib/utils';
import { Github } from 'lucide-react';

function Cmd({ children, copy }: { children: string; copy?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-card px-3.5 py-2.5 font-mono text-sm">
      <code className="overflow-x-auto whitespace-nowrap text-fg">
        <span className="text-faint">$ </span>
        {children}
      </code>
      <CopyButton
        value={copy ?? children}
        className="shrink-0 text-muted hover:bg-surface hover:text-fg"
      />
    </div>
  );
}

const steps = [
  {
    n: 1,
    title: 'Install globally',
    desc: 'Pulls the full stack. The TUI is lazy-loaded, so the plain REPL pays no startup cost.',
    cmd: `npm i -g ${META.npm}`,
  },
  {
    n: 2,
    title: 'Configure',
    desc: 'Run the wizard, or just launch — with no config the interactive provider picker appears.',
    cmd: 'wrongstack init',
  },
  {
    n: 3,
    title: 'Run',
    desc: 'Drop into the REPL, or go straight to the TUI. wstack is a built-in alias.',
    cmd: 'wrongstack --tui',
  },
];

const recipes = [
  { label: 'Director fleet', cmd: 'wrongstack --director "audit src/ for security issues"' },
  { label: 'Goal mode', cmd: 'wrongstack --goal "ship the REST API"' },
  { label: 'Pick a provider', cmd: 'wrongstack --provider groq --model llama-3.3-70b-versatile' },
  { label: 'Search models', cmd: 'wstack models openrouter --search claude --page 2' },
  { label: 'Resume a session', cmd: 'wrongstack --resume <session-id>' },
  { label: 'Skip catalog refresh', cmd: 'wrongstack --no-models-refresh' },
  { label: 'Minimal kernel (offline)', cmd: 'wrongstack --no-features' },
  { label: 'Add a key', cmd: 'wrongstack auth groq' },
];

export function Install() {
  return (
    <section id="install" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Get started"
          title="From zero to agent in"
          highlight="three commands"
          description={`Requires Node.js ${META.node}+ and pnpm 9+ or npm. Configuration lives under ~/.wrongstack/ — the only thing you commit is .wrongstack/AGENTS.md.`}
        />

        {/* 3-step quick start */}
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.07}>
              <div className="flex h-full flex-col rounded-2xl border border-line bg-surface/50 p-6">
                <div className="flex items-center gap-3">
                  <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-strong font-mono text-sm font-bold text-white">
                    {s.n}
                  </span>
                  <h3 className="text-base font-bold tracking-tight">{s.title}</h3>
                </div>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{s.desc}</p>
                <div className="mt-4">
                  <Cmd>{s.cmd}</Cmd>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Recipes */}
        <Reveal delay={0.1} className="mt-10">
          <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <h3 className="text-lg font-bold tracking-tight">Common recipes</h3>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {recipes.map((r) => (
                <div key={r.label}>
                  <div className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-faint">
                    {r.label}
                  </div>
                  <Cmd>{r.cmd}</Cmd>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* CTA */}
        <Reveal delay={0.12} className="mt-12 text-center">
          <p className="text-muted">Star it, read the source, file an issue.</p>
          <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" asChild className="sheen w-full sm:w-auto">
              <a href={META.repo} target="_blank" rel="noopener noreferrer">
                <Github className="size-4" /> Open the repository
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <a href={`${META.repo}#readme`} target="_blank" rel="noopener noreferrer">
                Read the docs
              </a>
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
