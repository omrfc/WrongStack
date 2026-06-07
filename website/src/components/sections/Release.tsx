'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy';
import { META, releaseProcess, releaseWorkflow } from '@/lib/utils';
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Rocket, ShieldCheck } from 'lucide-react';

export function Release() {
  return (
    <section id="release" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How we ship"
          title="From a green CI run to"
          highlight="npm in 5 steps"
          description="Every release is lockstep across all 15 workspace packages. A git tag triggers GitHub Actions, which typechecks, tests, builds, and publishes to npm on 3 platforms."
        />

        {/* Workflow banner */}
        <Reveal className="mt-12">
          <div className="rounded-2xl border border-line bg-gradient-to-r from-brand/5 via-brand-2/5 to-brand/5 p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-brand">
                  <Rocket className="size-4" />
                  Trigger
                </div>
                <p className="mt-1 text-lg font-bold tracking-tight">
                  Push a tag matching <code className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-sm text-brand">v*</code>
                </p>
                <p className="mt-2 text-sm text-muted">
                  The Release workflow typechecks, builds, and tests on Ubuntu, macOS, and Windows —
                  then publishes all workspace packages to npm and creates a GitHub Release.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="border-brand/30 text-brand">
                  <ShieldCheck className="mr-1 size-3" /> 3-platform CI
                </Badge>
                <Badge variant="outline" className="border-term-purple/30 text-term-purple">
                  Lockstep versioning
                </Badge>
              </div>
            </div>

            {/* Automation steps */}
            <div className="mt-6 grid gap-3 sm:grid-cols-4">
              {releaseWorkflow.automation.map((step, i) => (
                <div key={step} className="flex items-start gap-2.5 rounded-xl border border-line bg-surface p-3.5">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand/10 font-mono text-xs font-bold text-brand">
                    {i + 1}
                  </span>
                  <span className="text-sm text-muted">{step}</span>
                </div>
              ))}
            </div>

            {/* Secrets note */}
            <div className="mt-4 rounded-xl border border-line bg-card px-4 py-3">
              <span className="font-mono text-[11px] uppercase tracking-widest text-faint">Required secrets</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {releaseWorkflow.requiredSecrets.map((s) => (
                  <code key={s} className="rounded bg-surface px-2 py-0.5 font-mono text-xs text-brand">{s}</code>
                ))}
              </div>
            </div>
          </div>
        </Reveal>

        {/* Release process phases */}
        <div className="mt-10">
          <h3 className="text-lg font-bold tracking-tight">Release checklist</h3>
          <p className="mt-1 text-sm text-muted">
            Follows <a href={`${META.repo}/blob/main/RELEASE.md`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">RELEASE.md <ExternalLink className="inline size-3" /></a>.
          </p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {releaseProcess.map((phase, i) => (
            <Reveal key={phase.phase} delay={i * 0.06}>
              <div className="h-full rounded-2xl border border-line bg-card p-6">
                <div className="flex items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-strong font-mono text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  <h4 className="text-base font-bold tracking-tight">{phase.phase}</h4>
                </div>
                <ul className="mt-4 space-y-2.5">
                  {phase.steps.map((step) => (
                    <li key={`${phase.phase}-${step}`} className="flex items-start gap-2 text-[13px]">
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-term-green" />
                      <span className="text-muted">{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Hotfix process */}
        <Reveal delay={0.25} className="mt-8">
          <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-term-yellow" />
              <h3 className="text-lg font-bold tracking-tight">Hotfix process</h3>
            </div>
            <p className="mt-1 text-sm text-muted">
              If a critical bug is found after release, branch from the tag and bump the patch version:
            </p>
            <div className="mt-4 space-y-2">
              {releaseWorkflow.hotfix.map((cmd) => (
                <div key={cmd} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 font-mono text-sm">
                  <code className="text-fg">
                    <span className="text-faint">$ </span>
                    {cmd}
                  </code>
                  <CopyButton value={cmd} className="shrink-0 text-muted hover:bg-card hover:text-fg" />
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Pre-release note */}
        <Reveal delay={0.3} className="mt-4">
          <div className="rounded-2xl border border-dashed border-line bg-surface/40 p-5 text-center">
            <p className="text-sm text-muted">
              <span className="font-semibold text-fg">Pre-release tags:</span>{' '}
              {releaseWorkflow.preReleaseNote}
            </p>
          </div>
        </Reveal>

        {/* CTA */}
        <Reveal delay={0.35} className="mt-12 text-center">
          <Button size="lg" asChild className="sheen">
            <a href={`${META.repo}/releases`} target="_blank" rel="noopener noreferrer">
              View all releases on GitHub <ArrowRight className="size-4" />
            </a>
          </Button>
        </Reveal>
      </div>
    </section>
  );
}
