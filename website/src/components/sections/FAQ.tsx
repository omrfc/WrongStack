'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Reveal, SectionHeading } from '@/components/ui/reveal';

const faqs = [
  {
    q: 'Why “the wrong stack”?',
    a: 'It’s a wink. WrongStack is a serious autonomous coding agent that happens to be built in TypeScript on Node — the “wrong” choice for some. The point is that it ships, and works, anyway.',
  },
  {
    q: 'Which models and providers can it use?',
    a: 'Around 110 providers across four wire families (anthropic, openai, openai-compatible, google). The catalog refreshes from models.dev before boot completes — there are no hardcoded model names and no hardcoded pricing. Switch provider or model at runtime with the TUI /model picker, type to search after selecting a provider, or inspect models with wstack models --search --page --per-page.',
  },
  {
    q: 'Are my API keys safe?',
    a: 'Yes. API keys and MCP auth tokens are encrypted at rest with AES-256-GCM using a per-machine key kept at ~/.wrongstack/.key. Any plaintext key found in config.json is re-encrypted automatically on boot.',
  },
  {
    q: 'Do I have to use a GUI?',
    a: 'No. The plain readline REPL is the default and works everywhere a terminal does. The Ink TUI (--tui) and the web UI (webui) are both opt-in — the REPL never pays their import cost.',
  },
  {
    q: 'Can it run offline?',
    a: 'Yes. Use --no-models-refresh to skip only the boot-time models.dev refresh, or --no-features to boot a minimal kernel with no MCP, plugins, memory tools, models.dev fetch, or skill discovery. In full offline mode, declare the provider family in config.',
  },
  {
    q: 'How does it stay safe while editing my code?',
    a: 'Every mutating or destructive tool is mediated by the permission policy. Decisions persist to trust.json and are inherited by subagents. For trusted workflows, --yolo (or /yolo) auto-approves every tool call, including destructive ones; toggle /yolo destructive to put a confirmation gate back in front of risky operations.',
  },
  {
    q: 'What does it cost?',
    a: 'WrongStack is open source under the MIT license. You bring your own provider API key, so you pay your model provider directly — there’s no WrongStack subscription in between.',
  },
  {
    q: 'How often is it released?',
    a: 'WrongStack ships continuously. Push a git tag matching v* and GitHub Actions typechecks, builds, and tests on Ubuntu, macOS, and Windows — then publishes all 15 workspace packages to npm. Every release is lockstep (all packages at the same version) and documented in the changelog.',
  },
];

export function FAQ() {
  return (
    <section id="faq" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="FAQ"
          title="Questions, answered"
          highlight="straight"
          description="No marketing fog — every answer maps to something in the source."
        />

        <Reveal className="mt-12">
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger className="text-left text-base font-semibold">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent>
                  <p className="pr-6 text-sm leading-relaxed text-muted">{item.a}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}
