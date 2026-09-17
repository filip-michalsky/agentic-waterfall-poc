/**
 * Checkout.com storefront — Frames v2 in multi-frame mode: card number,
 * expiry date and CVV are separate iframes mounted inside our standard
 * #card-number / #card-expiry / #card-cvc containers.
 *
 * Flow: Frames tokenizes → page POSTs the tok_ to /checkout-com/api/pay →
 * server calls POST https://api.sandbox.checkout.com/payments and writes the
 * ledger from the response (Authorized / Declined + response_code).
 *
 * Decline simulation: not possible with a fixed PAN — the CKO sandbox drives
 * response codes off dedicated test card numbers only (docs: "Test cards"),
 * not amounts or holder names. `?simulate=decline` is accepted and recorded
 * but does not change behaviour.
 */
import { Router } from 'express';
import { getAttempt, updateAttempt, upsertAttempt } from '../attempts.js';
import { page } from '../page.js';

export const checkoutComRouter = Router();

const CKO_SANDBOX = 'https://api.sandbox.checkout.com';

function ckoCfg() {
  const secret = process.env.CKO_SECRET_KEY;
  const pub = process.env.CKO_PUBLIC_KEY;
  if (!secret || !pub) throw new Error('CKO_SECRET_KEY and CKO_PUBLIC_KEY are required');
  if (!secret.startsWith('sk_sbox_') && !secret.startsWith('sk_test_')) throw new Error('CKO_SECRET_KEY must be a SANDBOX key (sk_sbox_…)');
  return { secret, pub, processingChannelId: process.env.CKO_PROCESSING_CHANNEL_ID };
}

checkoutComRouter.get('/', (req, res) => {
  const attemptId = String(req.query.attempt ?? `manual-${Date.now()}`);
  const simulate = req.query.simulate ? String(req.query.simulate) : undefined;
  const amountCents = Number(req.query.amount ?? 1999);
  upsertAttempt({ id: attemptId, provider: 'checkout-com', amountCents, currency: 'USD', simulate: simulate ? `${simulate} (unsupported on CKO with a fixed PAN)` : undefined });
  const pub = process.env.CKO_PUBLIC_KEY ?? '';

  res.type('html').send(
    page({
      title: 'Checkout.com storefront',
      provider: 'checkout-com',
      attemptId,
      amountCents,
      scripts: ['https://cdn.checkout.com/js/framesv2.min.js'],
      body: `
      <form id="pay-form" autocomplete="off">
        <label>Cardholder name<input id="cardholder-name" name="name" placeholder="Name on card" autocomplete="off"></label>
        <label>Email<input id="email" name="email" placeholder="you@example.com" autocomplete="off"></label>
        <label>Card number<div id="card-number" class="hosted card-number-frame"></div></label>
        <div class="row">
          <label>Expiry<div id="card-expiry" class="hosted expiry-date-frame"></div></label>
          <label>CVC<div id="card-cvc" class="hosted cvv-frame"></div></label>
        </div>
        <label>Postal code<input id="postal" name="postal" placeholder="94103" autocomplete="off"></label>
        <button id="pay" type="submit">Pay $${(amountCents / 100).toFixed(2)}</button>
      </form>`,
      script: `
      Frames.init({
        publicKey: ${JSON.stringify(pub)},
        cardNumber: { frameSelector: '.card-number-frame' },
        expiryDate: { frameSelector: '.expiry-date-frame' },
        cvv: { frameSelector: '.cvv-frame' },
        style: { base: { fontSize: '16px' } },
      });
      Frames.addEventHandler(Frames.Events.CARD_TOKENIZED, async (event) => {
        setStatus('Tokenized ' + event.token + ' — paying…');
        const r = await fetch('/checkout-com/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: ATTEMPT_ID, token: event.token, name: document.getElementById('cardholder-name').value, email: document.getElementById('email').value }) }).then(r => r.json());
        if (r.error) return setStatus('Error: ' + r.error, 'error');
        setStatus('Checkout.com ' + r.status + (r.declineCode ? ' (' + r.declineCode + ')' : ''), r.status);
      });
      Frames.addEventHandler(Frames.Events.CARD_TOKENIZATION_FAILED, (e) => setStatus('Tokenization failed: ' + JSON.stringify(e), 'error'));
      document.getElementById('pay-form').addEventListener('submit', (e) => {
        e.preventDefault();
        Frames.cardholder = { name: document.getElementById('cardholder-name').value, billingAddress: { zip: document.getElementById('postal').value } };
        setStatus('Tokenizing…');
        Frames.submitCard();
      });`,
    }),
  );
});

checkoutComRouter.post('/api/pay', async (req, res) => {
  try {
    const attemptId = String(req.body.attemptId);
    const attempt = getAttempt(attemptId);
    if (!attempt) return res.status(404).json({ error: 'unknown attempt' });
    const { secret, processingChannelId } = ckoCfg();
    updateAttempt(attemptId, { status: 'submitted' });
    const body: Record<string, unknown> = {
      source: { type: 'token', token: String(req.body.token) },
      amount: attempt.amountCents,
      currency: attempt.currency,
      reference: `awf-${attempt.id}`,
      capture: true,
      customer: req.body.email ? { email: String(req.body.email), name: String(req.body.name ?? '') } : undefined,
      metadata: { attemptId: attempt.id },
    };
    if (processingChannelId) body.processing_channel_id = processingChannelId;
    const r = await fetch(`${CKO_SANDBOX}/payments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'Cko-Idempotency-Key': `awf-${attempt.id}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let payment: { id?: string; status?: string; response_code?: string; response_summary?: string; approved?: boolean } = {};
    try {
      payment = JSON.parse(text);
    } catch {
      /* non-JSON error */
    }
    if (!r.ok && r.status !== 422) {
      updateAttempt(attemptId, { status: 'error', message: `cko ${r.status}: ${text.slice(0, 200)}` });
      return res.status(500).json({ error: `cko ${r.status}: ${text.slice(0, 200)}` });
    }
    // 201 Authorized/Captured, 202 Pending (3DS), 422 request invalid
    const status =
      payment.approved === true || payment.status === 'Authorized' || payment.status === 'Captured'
        ? 'succeeded'
        : payment.status === 'Pending'
          ? 'pending'
          : payment.status === 'Declined'
            ? 'declined'
            : 'error';
    updateAttempt(attemptId, {
      status,
      providerRef: payment.id,
      declineCode: status === 'declined' ? `${payment.response_code ?? ''} ${payment.response_summary ?? ''}`.trim() : undefined,
      message: payment.response_summary ?? payment.status ?? text.slice(0, 120),
      raw: payment,
    });
    res.json({ status, providerRef: payment.id, declineCode: status === 'declined' ? payment.response_summary : undefined });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
