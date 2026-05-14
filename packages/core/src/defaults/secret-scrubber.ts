import type { SecretScrubber } from '../types/secret-scrubber.js';

interface Pattern {
  type: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  // Anchored at the start where possible so partial matches inside larger
  // strings don't trigger false positives.
  { type: 'anthropic_key', regex: /(?<![A-Za-z0-9])sk-ant-api\d+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g },
  { type: 'openai_key', regex: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g },
  { type: 'github_pat', regex: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g },
  { type: 'github_pat_v2', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])/g },
  { type: 'aws_access_key', regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { type: 'gcp_key', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g },
  { type: 'slack_token', regex: /(?<![A-Za-z0-9-])xox[abpos]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
  { type: 'stripe_key', regex: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g },
  { type: 'twilio_sid', regex: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g },
  {
    type: 'jwt',
    // Anchored: look for literal "eyJ" which is unambiguous for JWT header
    regex: /(?<![A-Za-z0-9/+=])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9/+=])/g,
  },
  {
    type: 'private_key',
    // Anchored: start must be BEGIN, end must be END with no extra dashes after END
    regex: /(?:^|\n)-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)? ?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----(?:\n|$)/g,
  },
  { type: 'mongodb_uri', regex: /mongodb(?:\+srv)?:\/\/[^\s"'`]+/g },
  { type: 'postgres_uri', regex: /postgres(?:ql)?:\/\/[^\s"'`]+/g },
  { type: 'mysql_uri', regex: /mysql:\/\/[^\s"'`]+/g },
  { type: 'redis_uri', regex: /redis:\/\/[^\s"'`]+/g },
  { type: 'bearer_token', regex: /(?<![A-Za-z0-9_.~+/-])Bearer\s+[A-Za-z0-9._~+/-]{20,}=*(?![A-Za-z0-9_.~+/-])/g },
  {
    type: 'high_entropy_env',
    // Value-side word boundary + length gate to avoid matching short random strings
    regex: /\b([A-Z_]{4,}(?:KEY|TOKEN|SECRET|PASSWORD|PWD))\s*[:=]\s*['"]?([A-Za-z0-9_/+=-]{20,})['"]?(?!\s*[A-Za-z_]{4,}(?:KEY|TOKEN|SECRET|PASSWORD|PWD))/g,
  },
];

/**
 * Per-chunk cap. The `high_entropy_env` and `bearer_token` patterns use
 * negative lookahead/lookbehind which are theoretically backtracking-prone
 * on adversarial input. Real scrub() inputs (LLM responses, tool outputs)
 * are typically much smaller, but defense-in-depth: split very long inputs
 * into smaller chunks and scrub each independently.
 */
const SCRUB_CHUNK_BYTES = 64 * 1024;

export class DefaultSecretScrubber implements SecretScrubber {
  scrub(text: string): string {
    if (!text) return text;
    // For oversize inputs, scrub in fixed chunks. We split on newlines
    // where possible so secrets that span a few hundred bytes still get
    // matched within a single chunk; only inputs above ~64 KB risk a
    // boundary cutting a secret in half, and those are uncommon.
    if (text.length <= SCRUB_CHUNK_BYTES) {
      return this.scrubOne(text);
    }
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + SCRUB_CHUNK_BYTES, text.length);
      // Try to break on a newline near the boundary so we don't cut secrets.
      if (end < text.length) {
        const nl = text.lastIndexOf('\n', end);
        if (nl > i + SCRUB_CHUNK_BYTES / 2) end = nl + 1;
      }
      out.push(this.scrubOne(text.slice(i, end)));
      i = end;
    }
    return out.join('');
  }

  private scrubOne(text: string): string {
    let out = text;
    for (const p of PATTERNS) {
      out = out.replace(p.regex, (_match, group1, group2) => {
        if (p.type === 'high_entropy_env' && group1 && group2) {
          return `${group1}=[REDACTED:${p.type}]`;
        }
        return `[REDACTED:${p.type}]`;
      });
    }
    return out;
  }

  scrubObject<T>(obj: T): T {
    const seen = new WeakSet();
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v as object)) return v;
      seen.add(v as object);
      if (Array.isArray(v)) return v.map(visit);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = visit(val);
      }
      return out;
    };
    return visit(obj) as T;
  }
}
