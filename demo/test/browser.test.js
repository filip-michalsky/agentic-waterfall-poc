import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../lib/runner.js';
import { sanitize } from '../lib/live-state.js';

const id = '11111111-1111-4111-8111-111111111111';

for (const failure of [null, 'fill', 'submit']) {
  test(`Stagehand run: ${failure ?? 'authorization'} preserves API order, one submission and cleanup`, async () => {
    const at = new Date().toISOString();
    let stored = { version: 1, mode: 'on-demand', broadcastId: id, revision: 1, state: 'running', amountCents: 1999, currency: 'USD', cardSource: 'inline', startedAt: at, receivedAt: at, events: [{ seq: 1, at, kind: 'run_started' }] };
    const calls = [], typed = [], archives = [];
    let closed = 0, clicks = 0, cardEntered = false;
    const page = {
      goto: async () => ({ ok: () => true }),
      waitForSelector: async () => true,
      evaluate: async (_, secret) => { if (secret) calls.push('prepare'); return true; },
      locator: (selector) => ({
        centroid: async () => ({ x: 100, y: 100 }),
        click: async () => {
          assert.equal(selector, '#pay');
          assert.equal(archives.at(-1).submitted, true);
          clicks++; calls.push('submit');
          if (failure === 'submit') throw new Error('Response lost');
        },
      }),
      click: async () => {},
      type: async (value) => { cardEntered = true; typed.push(value); calls.push('type'); },
    };
    await runDemo(stored, {
      ready: () => true, wait: async () => {},
      read: async () => ({ data: structuredClone(stored), etag: 'test' }),
      write: async (data) => { stored = structuredClone(data); },
      archive: async (data) => { archives.push(structuredClone(data)); },
      adyenAuthorize: async () => { calls.push('adyen'); return { verdict: { outcome: 'declined', declineClass: 'issuer_unavailable' } }; },
      stripeRequest: async (_, body) => {
        calls.push(body ? 'stripe-create' : 'stripe-verify');
        return { id: 'pi_test', client_secret: 'private-client-secret', livemode: false, amount: 1999, currency: 'usd', metadata: { demo_purchase: id }, status: 'requires_capture', capture_method: 'manual', amount_capturable: 1999 };
      },
      browserOpen: async () => {
        calls.push('browser');
        return {
          page, sessionId: '22222222-2222-4222-8222-222222222222',
          stagehand: { act: async (instruction, options) => {
            assert.equal(cardEntered, false, 'No inference after card entry');
            assert.match(instruction, /%value%/);
            assert(['Ada Lovelace', '10001'].includes(options.variables.value));
            if (failure === 'fill') return { data: { success: false } };
            return { data: { success: true } };
          } },
          close: async () => { closed++; },
        };
      },
    });
    assert.deepEqual(calls.slice(0, 3), ['adyen', 'stripe-create', 'browser']);
    assert.equal(closed, 1);
    assert.equal(clicks, failure === 'fill' ? 0 : 1);
    const decision = stored.events.findLast((event) => event.kind === 'decision');
    assert.equal(decision.outcome, failure === 'submit' ? 'unknown' : failure === 'fill' ? 'error' : 'succeeded');
    assert.equal(decision.decision, failure ? 'hard_stop' : 'stop');
    if (!failure) {
      assert.equal(calls.at(-1), 'stripe-verify');
      assert.equal(decision.captureState, 'authorized');
      assert.deepEqual(typed, ['4242424242424242', '1230', '123']);
      assert(calls.indexOf('prepare') > calls.lastIndexOf('type'));
    }
    assert.doesNotMatch(JSON.stringify(sanitize(archives.at(-1))), /private-client-secret|4242424242424242|pi_test/);
  });
}
