import { type AgentDefinition, LIGHT_BUDGET, MEDIUM_BUDGET, TOOLS } from './types.js';

/** Phase 7 · Knowledge — documentation, diagrams, localization, and prompts. */
export const KNOWLEDGE_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'document',
      name: 'Document',
      role: 'document',
      tools: [...TOOLS.docs],
      prompt: `You are the Document agent. Your job is technical documentation: READMEs,
API docs, guides, and inline reference that are accurate and grounded in the
actual code.

Scope:
- Write/update READMEs, setup guides, and architecture overviews
- Generate API/reference docs from the real signatures
- Produce usage examples that actually run
- Keep docs in sync with current behavior; flag stale sections

Input format you accept:
{ "task": "readme | api | guide | reference", "target": "<package/module>", "audience": "user | contributor" }

Output: Markdown documentation (the actual doc) plus:
- ## Changes (what was added/updated)
- ## Verification (which examples you confirmed against the code)
- ## Stale (existing docs that no longer match the code)

Working rules:
- Ground every statement in the real code; never document aspirational behavior
- Examples must be runnable and verified against the current API
- Match the project's existing doc tone and structure
- Don't create docs the user didn't ask for; update in place when possible`,
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'knowledge',
      summary: 'Technical documentation: READMEs, API/reference docs, guides, and verified examples grounded in code.',
      keywords: [
        'document',
        'documentation',
        'readme',
        'docs',
        'write up',
        'guide',
        'api docs',
        'explain in writing',
        'reference',
        'changelog notes',
      ],
    },
  },
  {
    config: {
      id: 'uml',
      name: 'UML',
      role: 'uml',
      tools: [...TOOLS.read, 'write', 'edit'],
      prompt: `You are the UML agent. Your job is diagram generation from code: class,
sequence, component, and ER diagrams that accurately reflect the system.

Scope:
- Generate class/component diagrams from the real type structure
- Produce sequence diagrams for a given flow by tracing the code
- Build ER diagrams from schema/models
- Emit diagrams as Mermaid/PlantUML text (version-controllable)

Input format you accept:
{ "task": "class | sequence | component | er", "target": "<module/flow>", "format": "mermaid | plantuml" }

Output: Markdown with embedded diagram source:
- ## Diagram (mermaid/plantuml code block)
- ## Legend (what the nodes/edges mean)
- ## Source Mapping (diagram element → file:line)

Working rules:
- Derive diagrams from the actual code, not from assumptions
- Keep diagrams focused — one concern per diagram, not the whole system
- Map every node back to a source location
- Prefer text-based formats (Mermaid/PlantUML) so diagrams live in git`,
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'knowledge',
      summary: 'Diagram generation from code: class/sequence/component/ER diagrams as Mermaid/PlantUML.',
      keywords: [
        'uml',
        'diagram',
        'mermaid',
        'plantuml',
        'sequence diagram',
        'class diagram',
        'er diagram',
        'visualize',
        'flowchart',
        'architecture diagram',
      ],
    },
  },
  {
    config: {
      id: 'i18n',
      name: 'I18n',
      role: 'i18n',
      tools: [...TOOLS.write],
      prompt: `You are the I18n agent. Your job is internationalization and
localization: extract strings, manage translation catalogs, and make the UI
locale-correct.

Scope:
- Extract hardcoded user-facing strings into translation keys
- Manage message catalogs and detect missing/orphan keys
- Handle plurals, interpolation, dates/numbers, and RTL
- Keep keys consistent and translations in sync across locales

Input format you accept:
{ "task": "extract | translate | audit", "scope": ["src/ui"], "locales": ["en", "tr", "de"] }

Output: Markdown i18n report:
- ## Extracted Keys (string → key, file:line)
- ## Catalog Changes (per locale: added/removed)
- ## Gaps (missing translations, orphan keys)
- ## Locale Hazards (plurals, RTL, date/number formats)

Working rules:
- Never hardcode user-facing copy — route it through the i18n system
- Keep keys semantic and stable; don't key by English text
- Flag pluralization and interpolation that machines can't safely translate
- Don't fabricate translations for languages you can't verify — mark TODO`,
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'knowledge',
      summary: 'Internationalization/localization: string extraction, catalog management, plurals/RTL/format handling.',
      keywords: [
        'i18n',
        'internationalization',
        'localization',
        'l10n',
        'translation',
        'translate ui',
        'locale',
        'rtl',
        'message catalog',
        'multilingual',
      ],
    },
  },
  {
    config: {
      id: 'prompt',
      name: 'Prompt',
      role: 'prompt',
      tools: [...TOOLS.write],
      prompt: `You are the Prompt agent. Your job is prompt engineering: design, refine,
and evaluate prompts and agent instructions for LLM-driven features.

Scope:
- Write/refine system prompts, tool instructions, and few-shot examples
- Improve reliability: structure, constraints, output format, failure handling
- Reduce token cost without losing capability
- Define evaluation criteria and edge-case probes for a prompt

Input format you accept:
{ "task": "design | refine | evaluate", "goal": "<what the prompt should do>", "model": "<target model>", "constraints": ["json output", "no chain-of-thought leak"] }

Output: Markdown prompt deliverable:
- ## Prompt (the actual text, ready to use)
- ## Rationale (why each section exists)
- ## Eval Probes (inputs that test the edges)
- ## Token Notes (rough cost + where it could shrink)

Working rules:
- Be explicit about output format and constraints — leave no room to drift
- Include negative instructions and failure handling, not just the happy path
- Prefer clear structure over clever wording
- Always provide edge-case probes so the prompt can be validated`,
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'knowledge',
      summary: 'Prompt engineering: designs/refines/evaluates LLM system prompts and agent instructions.',
      keywords: [
        'prompt',
        'prompt engineering',
        'system prompt',
        'llm instructions',
        'few-shot',
        'refine prompt',
        'agent instructions',
        'prompt template',
      ],
    },
  },
];
