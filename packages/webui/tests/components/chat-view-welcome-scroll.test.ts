import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatViewSrc = fs.readFileSync(
  path.resolve(__dirname, '../../src/components/ChatView/index.tsx'),
  'utf8',
);

describe('ChatView welcome empty state', () => {
  it('keeps the WelcomeScreen in its own scrollable pane', () => {
    expect(chatViewSrc).toContain('{rows.length === 0 && !isLoading ? (');
    expect(chatViewSrc).toContain('className="h-full overflow-y-auto overscroll-contain"');
    expect(chatViewSrc).toContain('className="mx-auto max-w-5xl w-full px-4 pt-4 pb-8"');
    expect(chatViewSrc).toContain('<WelcomeScreen />');
  });
});
