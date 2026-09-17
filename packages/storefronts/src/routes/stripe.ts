/**
 * Stripe storefront — split Card Elements (cardNumber / cardExpiry / cardCvc)
 * mounted in #card-number / #card-expiry / #card-cvc. Test mode only.
 *
 * Flow: page loads → POST /stripe/api/intent creates a PaymentIntent for the
 * attempt → the page confirms with stripe.confirmCardPayment → the page POSTs
 * the outcome to /stripe/api/outcome → the server re-reads the PaymentIntent
 * from Stripe (never trusts the browser) and writes the ledger.
 *
 * Decline simulation: `?simulate=decline` does NOT change the order amount
 * (the waterfall must carry ONE purchase). It short-circuits to a clearly
 * labelled `simulated_decline` at the same amount — no real Stripe call — so
 * the report shows a routable decline without altering the order or charging.
 */
import { Router } from 'express';
import Stripe from 'stripe';
import { getAttempt, updateAttempt, upsertAttempt } from '../attempts.js';
import { page } from '../page.js';

export const stripeRouter = Router();

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must be a TEST key (sk_test_…)');
  }
  return new Stripe(key);
}

stripeRouter.get('/', (req, res) => {
  const attemptId = String(req.query.attempt ?? `manual-${Date.now()}`);
  const simulate = req.query.simulate ? String(req.query.simulate) : undefined;
  const amountCents = Number(req.query.amount ?? 1999); // never changed by simulate — one purchase
  const currency = String(req.query.currency ?? 'usd');
  upsertAttempt({ id: attemptId, provider: 'stripe', amountCents, currency, simulate });

  const pk = process.env.STRIPE_PUBLISHABLE_KEY ?? '';
  res.type('html').send(
    page({
      title: 'Stripe storefront',
      provider: 'stripe',
      attemptId,
      amountCents,
      scripts: ['https://js.stripe.com/v3/'],
      body: `
      <form id="pay-form" autocomplete="off">
        <label>Cardholder name<input id="cardholder-name" name="name" placeholder="Name on card" autocomplete="off"></label>
        <label>Email<input id="email" name="email" placeholder="you@example.com" autocomplete="off"></label>
        <label>Card number<div id="card-number" class="hosted"></div></label>
        <div class="row">
          <label>Expiry<div id="card-expiry" class="hosted"></div></label>
          <label>CVC<div id="card-cvc" class="hosted"></div></label>
        </div>
        <label>Postal code<input id="postal" name="postal" placeholder="94103" autocomplete="off"></label>
        <button id="pay" type="submit">Pay $${(amountCents / 100).toFixed(2)}</button>
      </form>`,
      script: `
      const stripe = Stripe(${JSON.stringify(pk)});
      const elements = stripe.elements();
      const style = { base: { fontSize: '16px' } };
      const number = elements.create('cardNumber', { style, showIcon: true });
      const expiry = elements.create('cardExpiry', { style });
      const cvc = elements.create('cardCvc', { style });
      number.mount('#card-number'); expiry.mount('#card-expiry'); cvc.mount('#card-cvc');

      document.getElementById('pay-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        setStatus('Creating payment…');
        const intent = await fetch('/stripe/api/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: ATTEMPT_ID }) }).then(r => r.json());
        if (intent.error) return setStatus('Error: ' + intent.error, 'error');
        if (intent.simulated) return setStatus('Simulated decline (demo switch, same amount)', 'declined');
        setStatus('Confirming with Stripe…');
        const result = await stripe.confirmCardPayment(intent.clientSecret, {
          payment_method: {
            card: number,
            billing_details: {
              name: document.getElementById('cardholder-name').value || undefined,
              email: document.getElementById('email').value || undefined,
              address: { postal_code: document.getElementById('postal').value || undefined },
            },
          },
        });
        await fetch('/stripe/api/outcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: ATTEMPT_ID, intentId: intent.id }) });
        if (result.error) setStatus('Declined: ' + (result.error.decline_code || result.error.code || result.error.message), 'declined');
        else setStatus('Payment ' + result.paymentIntent.status + ' (' + result.paymentIntent.id + ')', result.paymentIntent.status === 'succeeded' ? 'succeeded' : 'pending');
      });`,
    }),
  );
});

stripeRouter.post('/api/intent', async (req, res) => {
  try {
    const attempt = getAttempt(String(req.body.attemptId));
    if (!attempt) return res.status(404).json({ error: 'unknown attempt' });
    // Labelled simulated decline — same amount, no real Stripe call, so the order
    // is never re-priced and nothing is authorized.
    if (attempt.simulate === 'decline') {
      updateAttempt(attempt.id, { status: 'declined', declineCode: 'simulated_decline', message: 'simulated decline (demo switch, same amount, no Stripe call)' });
      return res.json({ simulated: true });
    }
    const pi = await stripe().paymentIntents.create(
      {
        amount: attempt.amountCents,
        currency: attempt.currency,
        payment_method_types: ['card'],
        description: `agentic-waterfall attempt ${attempt.id}`,
        metadata: { attemptId: attempt.id, simulate: attempt.simulate ?? '' },
      },
      { idempotencyKey: `awf-${attempt.id}` },
    );
    updateAttempt(attempt.id, { status: 'submitted', providerRef: pi.id });
    res.json({ id: pi.id, clientSecret: pi.client_secret });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** Server re-reads the intent; browser input is only a trigger. */
stripeRouter.post('/api/outcome', async (req, res) => {
  try {
    const attemptId = String(req.body.attemptId);
    const attempt = getAttempt(attemptId);
    if (!attempt?.providerRef) return res.status(404).json({ error: 'unknown attempt / no intent' });
    const pi = await stripe().paymentIntents.retrieve(attempt.providerRef);
    const status = pi.status === 'succeeded' ? 'succeeded' : pi.last_payment_error ? 'declined' : pi.status === 'processing' ? 'pending' : 'pending';
    const err = pi.last_payment_error;
    updateAttempt(attemptId, {
      status,
      declineCode: err?.decline_code ?? err?.code ?? undefined,
      message: err?.message ?? pi.status,
      raw: { status: pi.status, charge: pi.latest_charge, error: err ? { code: err.code, decline_code: err.decline_code, type: err.type } : null },
    });
    res.json(getAttempt(attemptId));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
