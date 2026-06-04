'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { plugins, providerFamilies, skills, slashCommands, toolGroups } from '@/lib/utils';

export function Skills() {
  return (
    <section id="skills" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Batteries included"
          title="Everything ships"
          highlight="in the box"
          description="No marketplace hunt on day one. Tools, skills, providers and plugins are all wired in — discovered project → user → bundled, first-seen winning on name collisions."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          {/* Skills */}
          <Reveal>
            <div className="h-full rounded-2xl border border-line bg-card p-6 sm:p-7">
              <header className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold tracking-tight">Bundled skills</h3>
                <span className="font-mono text-xs text-faint">16</span>
              </header>
              <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                {skills.map((s) => (
                  <li
                    key={s.name}
                    className="group rounded-lg border border-line bg-surface p-3 transition-colors hover:border-brand/40"
                  >
                    <code className="text-sm font-semibold text-brand">{s.name}</code>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          {/* Tools */}
          <Reveal delay={0.06}>
            <div className="h-full rounded-2xl border border-line bg-card p-6 sm:p-7">
              <header className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold tracking-tight">Built-in tools</h3>
                <span className="font-mono text-xs text-faint">36</span>
              </header>
              <div className="mt-5 space-y-3.5">
                {toolGroups.map((g) => (
                  <div key={g.label}>
                    <div className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-faint">
                      {g.label}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {g.tools.map((t) => (
                        <span
                          key={t}
                          className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-muted"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          {/* Providers */}
          <Reveal delay={0.06}>
            <div className="h-full rounded-2xl border border-line bg-card p-6 sm:p-7">
              <header className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold tracking-tight">Provider families</h3>
                <span className="font-mono text-xs text-faint">~110 providers</span>
              </header>
              <p className="mt-2 text-xs text-muted">
                Catalog from models.dev — refreshed on boot, no hardcoded models, no hardcoded pricing.
              </p>
              <ul className="mt-4 space-y-2.5">
                {providerFamilies.map((f) => (
                  <li key={f.id} className="rounded-lg border border-line bg-surface p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3">
                      <code className="text-sm font-semibold text-fg">{f.id}</code>
                      <span className="text-[11px] text-faint">{f.transport}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {f.examples.map((e) => (
                        <span
                          key={e}
                          className="rounded bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand"
                        >
                          {e}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          {/* Plugins */}
          <Reveal delay={0.06}>
            <div className="h-full rounded-2xl border border-line bg-card p-6 sm:p-7">
              <header className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold tracking-tight">Official plugins</h3>
                <span className="font-mono text-xs text-faint">10</span>
              </header>
              <ul className="mt-5 divide-y divide-line">
                {plugins.map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-3 py-2.5">
                    <code className="text-sm font-semibold text-fg">{p.name}</code>
                    <span className="text-right text-xs text-muted">{p.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>

        {/* Slash command marquee */}
        <Reveal delay={0.1} className="mt-10">
          <div className="rounded-2xl border border-line bg-card py-5">
            <p className="px-6 font-mono text-[11px] uppercase tracking-widest text-faint">
              Slash commands
            </p>
            <div className="edge-fade mt-3 overflow-hidden">
              <div className="marquee flex w-max gap-2 px-6">
                {['a', 'b'].flatMap((copy) =>
                  slashCommands.map((c) => (
                    <span
                      key={`${copy}-${c}`}
                      className="rounded-md border border-line bg-surface px-2.5 py-1 font-mono text-xs text-muted"
                    >
                      {c}
                    </span>
                  )),
                )}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
