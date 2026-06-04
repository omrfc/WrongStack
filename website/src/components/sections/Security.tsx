'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { META } from '@/lib/utils';
import { Cloud, EyeOff, KeyRound, Lock, Network, ShieldCheck, Zap } from 'lucide-react';

const items = [
  {
    icon: ShieldCheck,
    title: 'Per-tool permission policy',
    body: 'Every tool declares auto, confirm, or deny. Decisions persist to trust.json and are inherited by subagents — destructive calls prompt before they run.',
  },
  {
    icon: Lock,
    title: 'Secrets encrypted at rest',
    body: 'API keys and MCP tokens are sealed with AES-256-GCM using a per-machine key (mode 0600). Random IV per write — same plaintext, different ciphertext.',
  },
  {
    icon: KeyRound,
    title: 'Plaintext auto-migration',
    body: 'The CLI scans config.json on every boot and re-encrypts any plaintext key it finds, with regex-based field detection. enc:v1:<iv>:<tag>:<ct>.',
  },
  {
    icon: Network,
    title: 'Network is locked down',
    body: 'The fetch tool blocks localhost and private IPs by default; opt in with WRONGSTACK_FETCH_ALLOW_PRIVATE=1. The bash tool runs behind an env allowlist.',
  },
  {
    icon: EyeOff,
    title: 'WebUI broadcasts are scrubbed',
    body: 'tool.started and tool.executed payloads are redacted before WebSocket broadcast, so API keys and bearer tokens do not leak to connected browser tabs.',
  },
  {
    icon: Cloud,
    title: 'Cloud sync stays in-bounds',
    body: 'Pulled sync entries reject .. traversal, absolute paths, and anything resolving outside the category root. File-backed categories also reject nested paths.',
  },
  {
    icon: Zap,
    title: 'YOLO when you mean it',
    body: '--yolo (or /yolo) skips every permission prompt for CI and trusted workflows. It is opt-in and never the default.',
  },
];

export function Security() {
  return (
    <section
      id="security"
      className="scroll-mt-20 border-y border-line bg-surface/40 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Security"
          title="You stay in control of"
          highlight="every mutating call"
          description="WrongStack assumes the agent can be wrong. Permissions, encryption, and network guards are defaults — not features you have to remember to enable."
        />

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
          {items.map((it, i) => (
            <Reveal key={it.title} delay={(i % 3) * 0.06}>
              <SpotlightCard className="h-full bg-card p-7">
                <span className="grid size-11 place-items-center rounded-xl border border-line bg-surface text-brand">
                  <it.icon className="size-5" />
                </span>
                <h3 className="mt-5 text-base font-bold tracking-tight">{it.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{it.body}</p>
              </SpotlightCard>
            </Reveal>
          ))}

          {/* Threat model callout */}
          <Reveal delay={0.12}>
            <a
              href={`${META.repo}/blob/main/SECURITY.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-full flex-col justify-center bg-gradient-to-br from-brand/10 to-brand-2/5 p-7 transition-colors hover:from-brand/15"
            >
              <h3 className="text-base font-bold tracking-tight">Threat model</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Adversary trust assumptions and the full threat model live in SECURITY.md.
              </p>
              <span className="mt-4 font-mono text-sm font-semibold text-brand">
                Read SECURITY.md →
              </span>
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
