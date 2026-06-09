/**
 * BM25 ranking implementation — no external dependencies.
 *
 * Algorithm: Okapi BM25 with standard parameters (k1=1.5, b=0.75).
 */

const K1 = 1.5;
const B = 0.75;

interface Bm25Doc {
  id: number;
  tokens: string[];
  raw: string;
  len: number;
}

/** Tokenise a string into lowercase word tokens. */
export function tokenise(text: string): string[] {
  // Preserve all Unicode letters + digits + $ + '. Split on everything else.
  const sanitised = text.replace(/[^\p{L}\p{N}$'_]/gu, ' ').replace(/_/g, ' ');
  return sanitised.toLowerCase().split(' ').filter(Boolean);
}

export interface IndexableDoc {
  id: number;
  text: string;
}

/**
 * Split a camelCase/SnakeCase identifier into its constituent words.
 * e.g. "complexOperation" → "complex Operation"
 *      "foo_bar_baz"       → "foo bar baz"
 * This allows a query for "complex" to match "complexOperation"
 * via the shared "complex" token.
 */
function splitName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * Build indexable text for BM25 from a symbol's fields.
 * The name is split into camelCase/SnakeCase words so that queries
 * like "complex" match "complexOperation". The verbatim name is
 * also included for exact-match queries.
 */
export function buildIndexableText(name: string, signature: string, docComment: string): string {
  return [splitName(name), name, signature, docComment].filter(Boolean).join(' ');
}

export function buildBm25Index(docs: IndexableDoc[]): Bm25Index {
  const documents: Bm25Doc[] = docs.map((d) => {
    const tokens = tokenise(d.text);
    return { id: d.id, tokens, raw: d.text, len: tokens.length };
  });

  const df: Record<string, number> = {};
  for (const doc of documents) {
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (!seen.has(t)) {
        df[t] = (df[t] ?? 0) + 1;
        seen.add(t);
      }
    }
  }

  const N = documents.length;
  const totalLen = documents.reduce((sum, d) => sum + d.len, 0);
  const avgLen = N === 0 ? 0 : totalLen / N;

  return new Bm25Index(documents, df, N, avgLen);
}

export class Bm25Index {
  private readonly safeAvgLen: number;

  constructor(
    private documents: Bm25Doc[],
    private df: Record<string, number>,
    private N: number,
    avgLen: number,
  ) {
    this.safeAvgLen = avgLen === 0 ? 1 : avgLen;
  }

  score(query: string, filter?: (id: number) => boolean): Array<{ id: number; score: number }> {
    const qTokens = tokenise(query);
    if (qTokens.length === 0) return [];

    const results: Array<{ id: number; score: number }> = [];

    for (const doc of this.documents) {
      if (filter && !filter(doc.id)) continue;

      let docScore = 0;
      for (const qTerm of qTokens) {
        let tf = 0;
        for (const t of doc.tokens) {
          if (t === qTerm) tf++;
        }
        if (tf === 0) continue;

        const dfVal = this.df[qTerm] ?? 0;
        if (dfVal === 0) continue;

        const idf = Math.log((this.N - dfVal + 0.5) / (dfVal + 0.5) + 1);
        const lenRatio = B * (doc.len / this.safeAvgLen);
        const tfComponent = (tf * (K1 + 1)) / (tf + K1 * (1 - B + lenRatio));

        docScore += idf * tfComponent;
      }

      if (docScore > 0) results.push({ id: doc.id, score: docScore });
    }

    return results;
  }

  getDoc(id: number): Bm25Doc | undefined {
    return this.documents.find((d) => d.id === id);
  }

  extractSnippet(docId: number, queryTokens: string[], radius = 40): string {
    const doc = this.getDoc(docId);
    if (!doc) return '';

    for (const tok of queryTokens) {
      const idx = doc.raw.toLowerCase().indexOf(tok);
      if (idx !== -1) {
        const start = Math.max(0, idx - radius);
        const end = Math.min(doc.raw.length, idx + tok.length + radius);
        const excerpt = doc.raw.slice(start, end);
        const ellipsis = '\u2026';
        return (start > 0 ? ellipsis : '') + excerpt + (end < doc.raw.length ? ellipsis : '');
      }
    }
    return doc.raw.slice(0, radius * 2) + (doc.raw.length > radius * 2 ? '\u2026' : '');
  }
}
