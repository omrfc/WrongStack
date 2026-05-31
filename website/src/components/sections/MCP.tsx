'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Out, Prompt, TerminalFrame } from '@/components/ui/terminal';
import { Network, Radio, Terminal } from 'lucide-react';

const transports = [
  {
    icon: Terminal,
    name: 'stdio',
    body: 'Spawn an MCP server as a child process and speak JSON-RPC 2.0 over its stdin/stdout — the default for local servers.',
  },
  {
    icon: Radio,
    name: 'sse',
    body: 'Connect to a remote server over Server-Sent Events for streaming responses across the network.',
  },
  {
    icon: Network,
    name: 'streamable-http',
    body: 'Talk to HTTP servers that stream newline-delimited JSON (NDJSON) — the modern remote transport.',
  },
];

export function MCP() {
  return (
    <section id="mcp" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Interoperable"
          title="Plug in any tool over"
          highlight="the Model Context Protocol"
          description="MCP servers extend the agent with tools it never shipped with. WrongStack speaks JSON-RPC 2.0 across three transports, namespaces every tool so names never collide, and reconnects on its own."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          {/* Transports + details */}
          <div className="space-y-6">
            <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
              {transports.map((t) => (
                <Reveal key={t.name}>
                  <SpotlightCard className="h-full bg-card p-6">
                    <span className="grid size-10 place-items-center rounded-xl border border-line bg-surface text-brand">
                      <t.icon className="size-5" />
                    </span>
                    <h3 className="mt-4 font-mono text-sm font-semibold text-fg">{t.name}</h3>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted">{t.body}</p>
                  </SpotlightCard>
                </Reveal>
              ))}
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <Reveal>
                <div className="h-full rounded-2xl border border-line bg-card p-6">
                  <h3 className="text-base font-bold tracking-tight">Namespaced tools</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    Every server's tools are exposed under a stable prefix, so two servers can ship a
                    tool with the same name without clashing.
                  </p>
                  <code className="mt-3 inline-block rounded-md border border-line bg-surface px-2.5 py-1 font-mono text-xs text-brand">
                    {'mcp__<server>__<tool>'}
                  </code>
                </div>
              </Reveal>
              <Reveal delay={0.06}>
                <div className="h-full rounded-2xl border border-line bg-card p-6">
                  <h3 className="text-base font-bold tracking-tight">Self-healing</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    The registry reconnects with exponential backoff and jitter, capped at five
                    cycles — then the server is marked{' '}
                    <code className="font-mono text-xs text-brand">failed</code> instead of looping
                    forever.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>

          {/* Terminal */}
          <Reveal delay={0.08}>
            <TerminalFrame title="wrongstack — /mcp">
              <div className="min-h-[260px] space-y-1.5">
                <Prompt>/mcp</Prompt>
                <div className="space-y-0.5 pl-4 text-zinc-400">
                  <div>
                    <Out tone="green">●</Out> filesystem{' '}
                    <span className="text-zinc-500">stdio · 7 tools</span>
                  </div>
                  <div>
                    <Out tone="green">●</Out> github{' '}
                    <span className="text-zinc-500">streamable-http · 12 tools</span>
                  </div>
                  <div>
                    <Out tone="yellow">●</Out> sentry{' '}
                    <span className="text-zinc-500">sse · reconnecting (2/5)</span>
                  </div>
                </div>
                <Prompt>use mcp__github__create_issue</Prompt>
                <div className="pl-4">
                  <Out tone="blue">▸ calling</Out>{' '}
                  <span className="text-zinc-400">github · create_issue</span>
                </div>
                <div className="pl-4">
                  <Out tone="green">✓ #128 opened</Out>
                </div>
                <Prompt>
                  <span className="caret" />
                </Prompt>
              </div>
            </TerminalFrame>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
