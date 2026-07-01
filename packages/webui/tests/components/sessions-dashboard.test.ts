import { describe, expect, it } from 'vitest';
import { sessionApiError } from '../../src/components/SessionsDashboard';

describe('sessionApiError', () => {
  it('uses structured API error bodies', async () => {
    const res = new Response(JSON.stringify({ error: 'SessionRegistry not available' }), {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'content-type': 'application/json' },
    });

    await expect(sessionApiError(res)).resolves.toBe('SessionRegistry not available');
  });

  it('falls back to text bodies before status text', async () => {
    const res = new Response('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'content-type': 'text/plain' },
    });

    await expect(sessionApiError(res)).resolves.toBe('Unauthorized');
  });
});
