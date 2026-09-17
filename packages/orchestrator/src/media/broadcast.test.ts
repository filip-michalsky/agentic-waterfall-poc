import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroadcast, type LiveEvent } from './broadcast.js';

test('broadcast lifecycle sends safe progress, preserves simulated labels and excludes extra response fields', async () => {
  const original = globalThis.fetch;
  const secret = process.env.LIVE_BROADCAST_SECRET;
  process.env.LIVE_BROADCAST_SECRET = 'broadcast-test-secret';
  const sent: Array<Record<string, any>> = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(String(options?.body))); return new Response('{}', { status: 200 }); };
  try {
    const broadcast = await startBroadcast({ amountCents: 1999, currency: 'usd', cardSource: 'vault' });
    await broadcast.emit({ kind: 'api_result', tier: 'checkout-com-api', outcome: 'declined', simulated: true, raw: { pan: '4242424242424242' } } as LiveEvent);
    await broadcast.emit({ kind: 'run_finished' });
    await broadcast.close();
    assert.equal(sent.at(-1)!.state, 'completed');
    assert.equal(sent.at(-1)!.events[1].simulated, true);
    assert.doesNotMatch(JSON.stringify(sent), /4242424242424242|broadcast-test-secret|raw/);
    assert.deepEqual(sent.map((x) => x.revision), [1, 2, 3]);
  } finally {
    globalThis.fetch = original;
    if (secret === undefined) delete process.env.LIVE_BROADCAST_SECRET; else process.env.LIVE_BROADCAST_SECRET = secret;
  }
});
