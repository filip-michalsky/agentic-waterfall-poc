import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartHandler, configured, DEMO_ORIGIN } from '../lib/start.js';
import { stripeVerdict } from '../lib/runner.js';
import { loadCheckout } from '../lib/browser.js';
import { canReplace, sanitize } from '../lib/live-state.js';

const time = Date.parse('2026-09-07T20:00:00Z');
const requestId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const req = (id = requestId) => ({ method: 'POST', headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' }, body: { requestId: id } });
const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function harness() {
  let stored = null, version = 0, launches = [], now = time;
  class BlobPreconditionFailedError extends Error {}
  const read = async () => stored ? { data: structuredClone(stored), etag: String(version) } : null;
  const write = async (data, etag) => {
    if (etag !== (version ? String(version) : undefined)) throw new BlobPreconditionFailedError();
    stored = structuredClone(data); version++;
  };
  const handler = createStartHandler({ read, write, launch: (data) => launches.push(data), ready: () => true, now: () => now });
  return { handler, launches, current: () => stored, finish: () => { stored.state = 'completed'; now += 60000; } };
}
test('simultaneous clicks reserve one run before launching; other viewers join it', async () => {
  const h = harness(), a = res(), b = res();
  await Promise.all([h.handler(req(), a), h.handler(req(otherId), b)]);
  assert.equal(h.launches.length, 1);
  assert.equal(a.body.broadcastId, b.body.broadcastId);
  assert.deepEqual([a.code, b.code].sort(), [200, 202]);
});
test('retrying the same request does not launch again; Run again creates a new purchase', async () => {
  const h = harness(), first = res();
  await h.handler(req(), first); h.finish();
  const retry = res(); await h.handler(req(), retry);
  assert.equal(h.launches.length, 1); assert.equal(retry.body.broadcastId, first.body.broadcastId);
  const next = res(); await h.handler(req(otherId), next);
  assert.equal(next.code, 202); assert.notEqual(next.body.broadcastId, first.body.broadcastId);
  assert.equal(h.launches.length, 2); assert.equal(h.launches[1].amountCents, 1999);
});
test('arbitrary destinations, cards and amounts cannot enter the runner, and cross-site starts fail', async () => {
  const h = harness();
  for (const unsafe of [
    { ...req(), method: 'GET' },
    { ...req(), headers: { ...req().headers, origin: 'https://attacker.example' } },
    { ...req(), body: { requestId, destination: 'https://attacker.example', amount: 1, card: 'secret' } },
  ]) { const out = res(); await h.handler(unsafe, out); assert(out.code >= 400); }
  assert.equal(h.launches.length, 0); assert.equal(h.current(), null);
});
test('production Stripe keys are rejected; the public projection hides private launch metadata', async () => {
  const env = { BLOB_READ_WRITE_TOKEN: 'private', BROWSERBASE_API_KEY: 'private', BROWSERBASE_PROJECT_ID: 'project', OPENAI_API_KEY: 'private', ADYEN_API_KEY: 'private', ADYEN_MERCHANT_ACCOUNT: 'test', STRIPE_SECRET_KEY: 'sk_test_example', STRIPE_PUBLISHABLE_KEY: 'pk_test_example' };
  assert.equal(configured({ ...env, OPENAI_API_KEY: '' }), false);
  assert.equal(configured(env), true); assert.equal(configured({ ...env, ADYEN_API_KEY: '' }), false); assert.equal(configured({ ...env, STRIPE_SECRET_KEY: 'sk_live_example' }), false);
  const h = harness(); await h.handler(req(), res());
  const publicState = sanitize({ ...h.current(), client_secret: 'private', connectUrl: 'private', providerRef: 'private' });
  assert.equal(publicState.mode, 'on-demand');
  for (const key of ['requestId', 'leaseUntil', 'client_secret', 'connectUrl', 'providerRef']) assert.equal(publicState[key], undefined);
});
test('an interrupted heartbeat does not release a browser that is still inside its bounded lease', async () => {
  const h = harness(); await h.handler(req(), res());
  const next = { ...h.current(), broadcastId: otherId };
  assert.equal(canReplace(h.current(), next, time + 46000), false);
  assert.equal(canReplace(h.current(), next, time + 241000), true);
});
test('only the expected test purchase awaiting manual capture is called authorized', () => {
  const intent = { livemode: false, amount: 1999, currency: 'usd', metadata: { demo_purchase: requestId }, status: 'requires_capture', capture_method: 'manual', amount_capturable: 1999 };
  assert.deepEqual(stripeVerdict(intent, requestId), { outcome: 'succeeded', captureState: 'authorized' });
  for (const change of [{ livemode: true }, { amount: 999 }, { status: 'requires_confirmation' }, { status: 'succeeded' }, { metadata: { demo_purchase: otherId } }]) assert.equal(stripeVerdict({ ...intent, ...change }, requestId).outcome, 'unknown');
  assert.equal(stripeVerdict({ ...intent, status: 'requires_action' }, requestId).outcome, 'pending');
});

test('checkout loading retries once before card entry; persistent failures stop', async () => {
  let navigations = 0, checks = 0;
  const page = {
    goto: async () => { navigations++; return { ok: () => true }; },
    waitForSelector: async () => ++checks > 1,
  };
  await loadCheckout(page, 'https://example.test/checkout');
  assert.equal(navigations, 2); assert.equal(checks, 2);
  navigations = 0;
  await assert.rejects(loadCheckout({ ...page, waitForSelector: async () => false }, 'https://example.test/checkout'));
  assert.equal(navigations, 2);
});
