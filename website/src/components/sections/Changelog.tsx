'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Button } from '@/components/ui/button';
import { changelog, META } from '@/lib/utils';
import { ExternalLink, GitCommitHorizontal, Sparkles, Star, Tag } from 'lucide-react';
import { useState } from 'react';

const ENTRY_LIMIT = 5;

export function Changelog() {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? changelog : changelog.slice(0, ENTRY_LIMIT);

  return (
    <section id="changelog" className="scroll-mt-20 border-t border-line bg-surface/40 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Release history"
          title="Every version,"
          highlight="one sentence at a time"
          description="All notable changes tracked in CHANGELOG.md following Keep a Changelog. Lockstep versioning across all 15 workspace packages — plus the marketing site — since 0.24.0."
        />

        <div className="mt-14 space-y-6">
          {visible.map((entry, i) => (
            <Reveal key={entry.version} delay={i * 0.05}>
              <SpotlightCard className="relative overflow-hidden rounded-2xl border border-line bg-card p-6 sm:p-8">
                {/* Version ribbon */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className={entry.latest
                      ? 'grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-brand-2 font-mono text-sm font-bold text-white shadow-sm shadow-brand/30'
                      : 'grid size-10 place-items-center rounded-xl border border-line bg-surface font-mono text-sm font-bold text-fg'
                    }>
                      v{entry.version.split('.')[0]}<span className="text-[10px] opacity-60">.{entry.version.split('.').slice(1).join('.')}</span>
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold tracking-tight">
                          {entry.tagline}
                        </h3>
                        {entry.latest && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                            <Star className="size-2.5" /> latest
                          </span>
                        )}
                        {entry.consolidated && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-term-purple/10 px-2 py-0.5 text-[11px] font-semibold text-term-purple">
                            <Sparkles className="size-2.5" /> consolidated
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 font-mono text-xs text-faint">
                        <span className="flex items-center gap-1">
                          <Tag className="size-3" />
                          v{entry.version}
                        </span>
                        <span className="flex items-center gap-1">
                          <GitCommitHorizontal className="size-3" />
                          {entry.date}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Highlights */}
                <ul className="mt-5 space-y-2">
                  {entry.highlights.map((h, hi) => (
                    <li key={hi} className="flex items-start gap-2.5 text-sm">
                      <span className="mt-1.5 block size-1.5 shrink-0 rounded-full bg-brand/60" />
                      <span className="text-muted">{h}</span>
                    </li>
                  ))}
                </ul>

                {/* Divider + link to full changelog on GitHub */}
                {entry.latest && (
                  <div className="mt-5 border-t border-line pt-4">
                    <a
                      href={`${META.repo}/blob/main/CHANGELOG.md`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
                    >
                      Full diff on GitHub <ExternalLink className="size-3" />
                    </a>
                  </div>
                )}
              </SpotlightCard>
            </Reveal>
          ))}
        </div>

        {/* Show more / less */}
        {changelog.length > ENTRY_LIMIT && (
          <div className="mt-8 text-center">
            <Button
              variant="outline"
              size="lg"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show fewer' : `Show all ${changelog.length} releases`}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
