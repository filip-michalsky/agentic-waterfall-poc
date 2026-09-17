/**
 * Adyen storefront — Custom Card Component (securedFields) from Adyen Web v5,
 * sessions flow. The three secured fields are mounted inside our standard
 * #card-number / #card-expiry / #card-cvc containers.
 *
 * Decline simulation (Adyen test env): the CARDHOLDER NAME is a trigger —
 * NOT_ENOUGH_BALANCE, CARD_EXPIRED, CVC_DECLINED, … so the orchestrator just
 * types the trigger as the holder name (see targets/adyen.ts). No server-side
 * switch needed.
 *
 * Verdict: the page POSTs the sessionResult; the server asks Adyen
 * GET /v71/sessions/{id}?sessionResult=… and writes the ledger from THAT.
 */
import { Router } from 'express';
import { getAttempt, updateAttempt, upsertAttempt } from '../attempts.js';
import { page } from '../page.js';

export const adyenRouter = Router();

const ADYEN_CHECKOUT_TEST = 'https://checkout-test.adyen.com/v71';
const ADYEN_SDK_VERSION = '5.71.1';

function adyenCfg() {
  const apiKey = process.env.ADYEN_API_KEY;
  const clientKey = process.env.ADYEN_CLIENT_KEY;
  const merchantAccount = process.env.ADYEN_MERCHANT_ACCOUNT;
  if (!apiKey || !clientKey || !merchantAccount) throw new Error('ADYEN_API_KEY, ADYEN_CLIENT_KEY and ADYEN_MERCHANT_ACCOUNT are required');
  if (!clientKey.startsWith('test_')) throw new Error('ADYEN_CLIENT_KEY must be a TEST client key (test_…)');
  return { apiKey, clientKey, merchantAccount };
}

async function adyen<T>(path: string, init: RequestInit): Promise<T> {
  const { apiKey } = adyenCfg();
  const res = await fetch(`${ADYEN_CHECKOUT_TEST}${path}`, {
    ...init,
    headers: { 'x-API-key': apiKey, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Adyen ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

adyenRouter.get('/', (req, res) => {
  const attemptId = String(req.query.attempt ?? `manual-${Date.now()}`);
  const simulate = req.query.simulate ? String(req.query.simulate) : undefined;
  const amountCents = Number(req.query.amount ?? 1999);
  upsertAttempt({ id: attemptId, provider: 'adyen', amountCents, currency: 'USD', simulate });
  const clientKey = process.env.ADYEN_CLIENT_KEY ?? '';
  const origin = process.env.STOREFRONT_URL ?? `http://localhost:${process.env.STOREFRONT_PORT ?? 4321}`;

  res.type('html').send(
    page({
      title: 'Adyen storefront',
      provider: 'adyen',
      attemptId,
      amountCents,
      scripts: [`https://checkoutshopper-test.adyen.com/checkoutshopper/sdk/${ADYEN_SDK_VERSION}/adyen.js`],
      body: `
      <link rel="stylesheet" href="https://checkoutshopper-test.adyen.com/checkoutshopper/sdk/${ADYEN_SDK_VERSION}/adyen.css" />
      <!-- The Adyen Card component renders its own labelled iframes (card number,
           expiry, security code) and its own Pay button, and encrypts + submits
           through the session. The agent fills the iframes by their titles. -->
      <div id="card-container"></div>`,
      script: `
      (async () => {
        const session = await fetch('/adyen/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: ATTEMPT_ID, origin: ${JSON.stringify(origin)} }) }).then(r => r.json());
        if (session.error) return setStatus('Error: ' + session.error, 'error');
        const checkout = await AdyenCheckout({
          environment: 'test',
          clientKey: ${JSON.stringify(clientKey)},
          session: { id: session.id, sessionData: session.sessionData },
          onPaymentCompleted: async (result) => {
            await fetch('/adyen/api/outcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: ATTEMPT_ID, sessionResult: result.sessionResult, resultCode: result.resultCode }) });
            setStatus('Adyen ' + result.resultCode, result.resultCode === 'Authorised' ? 'succeeded' : result.resultCode === 'Refused' ? 'declined' : 'pending');
          },
          onError: async (err) => {
            await fetch('/adyen/api/outcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: ATTEMPT_ID, error: String(err && (err.message || err.name || err)) }) });
            setStatus('Error: ' + (err && (err.message || err.name)), 'error');
          },
        });
        checkout.create('card', {
          hasHolderName: true,
          holderNameRequired: true,
          showPayButton: true,
          brands: ['mc', 'visa', 'amex', 'discover'],
          styles: { base: { fontSize: '16px' } },
        }).mount('#card-container');
        setStatus('Card form ready.');
      })();`,
    }),
  );
});

adyenRouter.post('/api/session', async (req, res) => {
  try {
    const attempt = getAttempt(String(req.body.attemptId));
    if (!attempt) return res.status(404).json({ error: 'unknown attempt' });
    const { merchantAccount } = adyenCfg();
    const origin = String(req.body.origin ?? process.env.STOREFRONT_URL ?? 'http://localhost:4321');
    const session = await adyen<{ id: string; sessionData: string }>('/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': `awf-${attempt.id}` },
      body: JSON.stringify({
        merchantAccount,
        amount: { currency: attempt.currency, value: attempt.amountCents },
        reference: `awf-${attempt.id}`,
        returnUrl: `${origin}/adyen/return?attempt=${attempt.id}`,
        countryCode: 'US',
        channel: 'Web',
        shopperReference: 'agentic-waterfall-demo',
        metadata: { attemptId: attempt.id },
      }),
    });
    updateAttempt(attempt.id, { status: 'submitted', providerRef: session.id });
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

adyenRouter.post('/api/outcome', async (req, res) => {
  try {
    const attemptId = String(req.body.attemptId);
    const attempt = getAttempt(attemptId);
    if (!attempt?.providerRef) return res.status(404).json({ error: 'unknown attempt / no session' });
    if (req.body.error) {
      updateAttempt(attemptId, { status: 'error', message: String(req.body.error) });
      return res.json(getAttempt(attemptId));
    }
    const sessionResult = String(req.body.sessionResult ?? '');
    const result = await adyen<{ id: string; status: string }>(`/sessions/${attempt.providerRef}?sessionResult=${encodeURIComponent(sessionResult)}`, { method: 'GET' });
    // status: completed | paymentPending | refused | canceled | expired
    const status = result.status === 'completed' ? 'succeeded' : result.status === 'refused' ? 'declined' : result.status === 'paymentPending' ? 'pending' : 'error';
    updateAttempt(attemptId, {
      status,
      declineCode: status === 'declined' ? String(req.body.resultCode ?? 'Refused') : undefined,
      message: `adyen session ${result.status} (resultCode ${req.body.resultCode ?? 'n/a'})`,
      raw: { session: result, resultCode: req.body.resultCode },
    });
    res.json(getAttempt(attemptId));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

adyenRouter.get('/return', (req, res) => {
  res.type('html').send(`<!doctype html><title>Adyen return</title><body style="font:15px system-ui;padding:32px"><div id="status" data-status="returned">Returned from Adyen redirect for attempt ${String(req.query.attempt ?? '')}. sessionResult=${String(req.query.sessionResult ?? '')}</div></body>`);
});
