import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAdyen, adyenMayContinue, adyenVerdict } from '../lib/adyen.js';
import { runDemo } from '../lib/runner.js';
import { sanitize } from '../lib/live-state.js';

const id = '11111111-1111-4111-8111-111111111111';
const env = { ADYEN_API_KEY: 'private-test-key', ADYEN_MERCHANT_ACCOUNT: 'test-merchant', ADYEN_CHECKOUT_API: 'https://attacker.example' };
const refused = { pspReference: 'TESTREFERENCE123', resultCode: 'Refused', refusalReason: 'Issuer Unavailable', refusalReasonCode: '9' };

test('Adyen uses only its fixed test host, fixture, purchase amount and stable idempotency key', async () => {
  const calls = [];
  const request = async (url, options) => { calls.push({ url, ...options }); return Response.json(refused); };
  const result = await authorizeAdyen(id, { env, request });
  await authorizeAdyen(id, { env, request });
  assert.equal(result.providerRef, refused.pspReference);
  assert.equal(adyenMayContinue(result.verdict), true);
  assert.equal(calls[0].url, 'https://checkout-test.adyen.com/v71/payments');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers['x-API-key'], env.ADYEN_API_KEY);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.amount, { currency: 'USD', value: 1999 });
  assert.equal(body.reference, `demo-${id}`);
  assert.equal(body.paymentMethod.encryptedCardNumber, 'test_4111111111111111');
  assert.equal(body.paymentMethod.number, undefined);
  assert.deepEqual(body.additionalData, { RequestedTestAcquirerResponseCode: '9' });
  await assert.rejects(authorizeAdyen('untrusted-purchase', { env, request }));
  await assert.rejects(authorizeAdyen(id, { env: {}, request }));
  assert.equal(calls.length, 2);
});

test('only a confirmed, exact eligible refusal permits continuing; auth, fraud, 3DS and ambiguity stop', () => {
  assert.equal(adyenMayContinue(adyenVerdict(refused)), true);
  for (const change of [
    { pspReference: undefined }, { resultCode: 'Authorised' }, { resultCode: 'ChallengeShopper' },
    { resultCode: 'Pending' }, { resultCode: 'Error' }, { refusalReasonCode: '20', refusalReason: 'FRAUD' },
    { refusalReasonCode: '6', refusalReason: 'Expired Card' }, { refusalReasonCode: '9', refusalReason: 'FRAUD' },
  ]) assert.equal(adyenMayContinue(adyenVerdict({ ...refused, ...change })), false);
  assert.deepEqual(adyenVerdict({ ...refused, resultCode: 'Authorised' }), { outcome: 'succeeded' });
  assert.equal(adyenVerdict({ ...refused, resultCode: 'ChallengeShopper' }).outcome, 'pending');
});

test('network, permissions and malformed responses never become retry-eligible declines or leak raw data', async () => {
  for (const request of [
    async () => { throw new Error('private-provider-body'); },
    async () => Response.json({ errorCode: '010', message: 'private-provider-body' }, { status: 403 }),
    async () => new Response('not json'),
    async () => Response.json({ raw: 'private-provider-body' }),
  ]) assert.deepEqual(await authorizeAdyen(id, { env, request }), { verdict: { outcome: 'unknown' } });
});

test('hosted runner archives Adyen before any browser and stops every non-eligible result', async () => {
  for (const verdict of [{ outcome: 'unknown' }, { outcome: 'pending', declineClass: 'authentication_required' }, { outcome: 'succeeded' }, { outcome: 'declined', declineClass: 'unknown' }]) {
    const at = new Date().toISOString();
    let stored = { version: 1, mode: 'on-demand', broadcastId: id, revision: 1, state: 'running', amountCents: 1999, currency: 'USD', cardSource: 'inline', startedAt: at, receivedAt: at, events: [{ seq: 1, at, kind: 'run_started' }] };
    const archives = [];
    await runDemo(stored, {
      ready: () => true, wait: async () => {}, read: async () => ({ data: structuredClone(stored), etag: 'test' }),
      write: async (data) => { stored = structuredClone(data); }, archive: async (data) => { archives.push(structuredClone(data)); },
      adyenAuthorize: async (purchaseId) => {
        assert.equal(purchaseId, id);
        assert.equal(archives.at(-1).submitted, true);
        assert.equal(archives.at(-1).tier, 'adyen-api');
        return { verdict, providerRef: 'PRIVATE_PROVIDER_REF' };
      },
    });
    assert.equal(stored.state, 'completed');
    assert(!stored.events.some((e) => e.kind.startsWith('browser_') || e.kind.startsWith('checkout_api_')));
    assert.equal(stored.events.findLast((e) => e.kind === 'decision').decision, verdict.outcome === 'unknown' ? 'hard_stop' : 'stop');
    const publicState = sanitize(archives.at(-1));
    assert.equal(publicState.events.find((e) => e.tier === 'adyen-api').testResponse, true);
    assert(!JSON.stringify(publicState).includes('PRIVATE_PROVIDER_REF'));
    assert.equal(publicState.attempts, undefined);
  }
});
