import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, sanitize, canReplace, currentBrowser, safeLiveUrl, createHandler } from '../lib/live-state.js';

const now = Date.parse('2026-09-07T20:00:00Z');
const id = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const state = (events = [{ kind: 'run_started' }]) => ({ broadcastId: id, revision: 1, state: 'running', amountCents: 1999, currency: 'USD', cardSource: 'vault', startedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), events: events.map((e, i) => ({ ...e, seq: i + 1, at: new Date(now).toISOString() })) });
function response() { return { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }

test('the public projection drops raw card, token, checkout URL and provider error fields', () => {
  const input = state([{ kind: 'api_result', tier: 'checkout-com-api', outcome: 'declined', simulated: true, raw: { number: '4242424242424242' }, message: 'secret', url: 'https://checkout.invalid/?client_secret=secret' }]);
  input.tokenId = 'private-token';
  const out = sanitize(input);
  assert.equal(out.events[0].simulated, true);
  assert.doesNotMatch(JSON.stringify(out), /4242424242424242|private-token|client_secret|message|raw/);
  assert.throws(() => sanitize(state([{ kind: 'api_result', outcome: 'provider-specific-untrusted-text' }])));
});
test('authentication compares the exact bearer and rejects absent configuration', () => {
  assert.equal(authorized('Bearer shared-secret', 'shared-secret'), true);
  assert.equal(authorized('Bearer other', 'shared-secret'), false);
  assert.equal(authorized('Bearer undefined', undefined), false);
});
test('old revisions and another live presenter cannot replace the current broadcast', () => {
  const previous = state();
  assert.equal(canReplace(previous, previous, now), false);
  assert.equal(canReplace(previous, { ...previous, revision: 2 }, now), true);
  const other = { ...previous, broadcastId: sessionId };
  assert.equal(canReplace(previous, other, now), false);
  assert.equal(canReplace(previous, other, now + 46000), true);
});
test('browser view follows only the current attempt and rejects unsafe URL origins', () => {
  const live = state([{ kind: 'browser_started', sessionId }, { kind: 'browser_filling' }]);
  assert.equal(currentBrowser(live), sessionId);
  live.events.push({ kind: 'browser_result' });
  assert.equal(currentBrowser(live), undefined);
  assert.equal(safeLiveUrl('https://evil.example/'), undefined);
  assert.equal(safeLiveUrl('javascript:alert(1)'), undefined);
  assert.match(safeLiveUrl('https://www.browserbase.com/view?id=test'), /navbar=false/);
});
test('unauthorized writes do not touch storage; stale broadcasts cannot expose a live view', async () => {
  let reads = 0, writes = 0, views = 0;
  const old = state([{ kind: 'browser_started', sessionId }]);
  const handler = createHandler({ read: async () => { reads++; return { data: old }; }, write: async () => { writes++; }, liveView: async () => { views++; }, secret: () => 'secret', now: () => now + 46000 });
  const post = response(); await handler({ method: 'POST', headers: {}, body: old }, post);
  assert.equal(post.code, 401); assert.equal(reads, 0); assert.equal(writes, 0);
  const get = response(); await handler({ method: 'GET', headers: {} }, get);
  assert.equal(get.code, 200); assert.equal(get.body.stale, true); assert.equal(views, 0);
  assert.equal(get.headers['Cache-Control'], 'private, no-store');
});
test('a valid publisher update writes only the sanitized snapshot and uses the previous etag', async () => {
  let written;
  const handler = createHandler({ read: async () => ({ data: state(), etag: 'etag-1' }), write: async (data, etag) => { written = { data, etag }; }, liveView: async () => null, secret: () => 'secret', now: () => now });
  const res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: { ...state(), revision: 2, pan: '4242424242424242' } }, res);
  assert.equal(res.code, 200); assert.equal(written.etag, 'etag-1'); assert.equal(written.data.pan, undefined);
});

test('API animation events expose only fixed phases and actions, and keep the browser session attached', () => {
  const input = state([
    { kind: 'api_progress', tier: 'checkout-com-api', apiPhase: 'proxy', simulated: true },
    { kind: 'browser_started', tier: 'stripe', sessionId },
    { kind: 'checkout_api_started', tier: 'stripe', apiAction: 'create_intent', request: { Authorization: 'secret' } },
    { kind: 'checkout_api_result', tier: 'stripe', apiAction: 'create_intent', apiStatus: 'received', client_secret: 'secret' },
  ]);
  const clean = sanitize(input);
  assert.equal(currentBrowser(clean), sessionId);
  assert.equal(clean.events[0].apiPhase, 'proxy');
  assert.equal(clean.events[3].apiStatus, 'received');
  assert.doesNotMatch(JSON.stringify(clean), /Authorization|client_secret|secret/);
  assert.throws(() => sanitize(state([{ kind: 'api_progress', apiPhase: 'untrusted free text' }])));
  assert.throws(() => sanitize(state([{ kind: 'checkout_api_started', apiAction: 'https://attacker.example' }])));
});
