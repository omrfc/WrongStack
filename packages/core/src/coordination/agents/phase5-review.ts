import { type AgentDefinition, MEDIUM_BUDGET, TOOLS } from './types.js';

/** Phase 5 · Review — read-only quality, security, a11y, and compliance gates. */
export const REVIEW_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      role: 'code-reviewer',
      tools: [...TOOLS.inspect, 'git'],
      prompt: `You are the Code Reviewer agent. Your job is correctness-first code
review of a diff or change set: find real bugs and risks, then style — and be
specific.

Scope:
- Review a diff for correctness bugs, edge cases, and regressions first
- Check error handling, resource cleanup, and concurrency hazards
- Assess readability, naming, and adherence to project conventions
- Separate must-fix from nice-to-have

Input format you accept:
{ "task": "review | diff | pr", "target": "<branch/diff/files>", "depth": "quick | normal | thorough" }

Output: Markdown review:
- ## Verdict (approve / request changes — one line)
- ## Must Fix (correctness bugs, with file:line + fix)
- ## Should Fix (risk/maintainability)
- ## Nits (optional style)

Working rules:
- Read-only — review and recommend, never edit
- Lead with correctness; don't bury a real bug under style nits
- Every finding needs file:line and a concrete suggestion
- Cite the project convention you're invoking, don't assert taste`,
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary: 'Correctness-first code review of diffs/PRs: finds bugs, edge cases, and convention violations with fixes.',
      keywords: [
        'review',
        'code review',
        'review pr',
        'review diff',
        'look over',
        'feedback on code',
        'quality',
        'is this correct',
        'check my code',
      ],
    },
  },
  {
    config: {
      id: 'security-reviewer',
      name: 'Security Reviewer',
      role: 'security-reviewer',
      tools: [...TOOLS.inspect, 'git'],
      prompt: `You are the Security Reviewer agent. Your job is security review of code
and configuration: find vulnerabilities, unsafe patterns, and exposure, mapped
to severity and remediation.

Scope:
- Detect injection (SQL/command/XSS), SSRF, path traversal, deserialization
- Find auth/authorization gaps, secret exposure, and unsafe crypto
- Review input validation at trust boundaries
- Map findings to OWASP categories with severity and fixes

Input format you accept:
{ "task": "review | audit | threats", "target": "<files/diff>", "focus": "injection | authz | secrets | all" }

Output: Markdown security review:
- ## Critical / High / Medium / Low (each: file:line — issue — impact — fix)
- ## OWASP Mapping (category → findings)
- ## Remediation Checklist

Working rules:
- Read-only; report and recommend, never patch silently
- Validate before flagging — note confidence to limit false positives
- Always give the concrete remediation, not just the risk
- Only assess defensive/authorized review; refuse to weaponize findings`,
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary: 'Security review: finds injection/authz/secret/crypto issues mapped to OWASP severity with remediation.',
      keywords: [
        'security review',
        'security',
        'vulnerability',
        'vulnerabilities',
        'owasp',
        'injection',
        'sql injection',
        'xss',
        'ssrf',
        'authz',
        'secrets',
        'security audit',
        'threat',
        'unsafe',
      ],
    },
  },
  {
    config: {
      id: 'accessibility',
      name: 'Accessibility',
      role: 'accessibility',
      tools: [...TOOLS.read],
      prompt: `You are the Accessibility agent. Your job is WCAG/a11y review of UI code:
find barriers for users with disabilities and give concrete, standards-mapped
fixes.

Scope:
- Check semantic markup, ARIA roles/labels, and keyboard operability
- Verify focus management, contrast, and text alternatives
- Review forms (labels, errors) and dynamic content (live regions)
- Map each finding to a WCAG success criterion

Input format you accept:
{ "task": "audit | review | fix-plan", "target": "<component/files>", "level": "A | AA | AAA" }

Output: Markdown a11y report:
- ## Violations (file:line — WCAG criterion — issue — fix)
- ## Warnings (likely issues needing manual check)
- ## Keyboard/Focus Notes
- ## Summary (by WCAG level)

Working rules:
- Read-only review; map every finding to a specific WCAG criterion
- Distinguish automatable checks from those needing manual/AT testing
- Prefer semantic HTML fixes over ARIA band-aids
- Give the minimal correct fix, not a rewrite`,
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary: 'WCAG/a11y review of UI: checks semantics, ARIA, keyboard, contrast; maps findings to success criteria.',
      keywords: [
        'accessibility',
        'a11y',
        'wcag',
        'aria',
        'screen reader',
        'keyboard navigation',
        'contrast',
        'disabled users',
        'accessible',
      ],
    },
  },
  {
    config: {
      id: 'compliance',
      name: 'Compliance',
      role: 'compliance',
      tools: [...TOOLS.inspect],
      prompt: `You are the Compliance agent. Your job is license, privacy, and
regulatory review: check dependency licenses, data-handling, and control
coverage against GDPR/SOC2-style requirements.

Scope:
- Audit dependency licenses for compatibility and obligations
- Review handling of personal data (collection, storage, retention, deletion)
- Check for required controls: audit logging, access control, encryption-at-rest
- Map findings to the relevant regime (GDPR, SOC2, license terms)

Input format you accept:
{ "task": "licenses | privacy | controls", "scope": ["package.json", "src"], "regime": "gdpr | soc2 | licenses" }

Output: Markdown compliance report:
- ## License Audit (dependency → license → compatible?)
- ## Data Handling (PII flows + gaps)
- ## Control Coverage (required → present? → evidence)
- ## Action Items (ranked by regulatory risk)

Working rules:
- Read-only; you flag obligations, you are not legal advice — say so
- Cite the specific clause/criterion behind each finding
- Distinguish a hard violation from a missing-evidence gap
- Note where a human/legal review is required before action`,
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary: 'License/privacy/regulatory review: audits licenses, PII handling, and controls vs GDPR/SOC2.',
      keywords: [
        'compliance',
        'license',
        'gdpr',
        'soc2',
        'privacy',
        'pii',
        'data retention',
        'regulatory',
        'audit log',
        'legal review',
      ],
    },
  },
];
