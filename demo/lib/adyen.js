// Hosted education fixture: Adyen's documented test_ encrypted-card fields.
// This direct sandbox request does not demonstrate Basis Theory detokenization.
const endpoint = 'https://checkout-test.adyen.com/v71/payments';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adyenVerdict(body) {
  if (!body || typeof body.pspReference !== 'string' || !/^[a-zA-Z0-9]{8,64}$/.test(body.pspReference)) return { outcome: 'unknown' };
  if (body.resultCode === 'Authorised') return { outcome: 'succeeded' };
  if (['RedirectShopper', 'ChallengeShopper', 'IdentifyShopper', 'Pending', 'Received'].includes(body.resultCode)) return { outcome: 'pending', declineClass: 'authentication_required' };
  if (body.resultCode === 'Refused') {
    // Only the exact, confirmed sandbox response we requested may hand off.
    const expected = String(body.refusalReasonCode) === '9' && body.refusalReason === 'Issuer Unavailable';
    return { outcome: 'declined', declineClass: expected ? 'issuer_unavailable' : 'unknown' };
  }
  return { outcome: 'unknown' };
}

export function adyenMayContinue(verdict) {
  return verdict.outcome === 'declined' && verdict.declineClass === 'issuer_unavailable';
}

export async function authorizeAdyen(broadcastId, { env = process.env, request = fetch } = {}) {
  if (!uuid.test(broadcastId) || !env.ADYEN_API_KEY || !env.ADYEN_MERCHANT_ACCOUNT) throw new Error('Adyen sandbox configuration required');
  try {
    const response = await request(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', 'x-API-key': env.ADYEN_API_KEY, 'Idempotency-Key': `demo-${broadcastId}-adyen` },
      body: JSON.stringify({
        merchantAccount: env.ADYEN_MERCHANT_ACCOUNT, amount: { currency: 'USD', value: 1999 },
        reference: `demo-${broadcastId}`, returnUrl: 'https://soap-agentic-waterfall-demo.vercel.app/live',
        paymentMethod: {
          type: 'scheme', encryptedCardNumber: 'test_4111111111111111',
          encryptedExpiryMonth: 'test_03', encryptedExpiryYear: 'test_2030', encryptedSecurityCode: 'test_737', holderName: 'Ada Lovelace',
        },
        additionalData: { RequestedTestAcquirerResponseCode: '9' },
      }),
    });
    if (!response.ok) return { verdict: { outcome: 'unknown' } };
    const body = await response.json();
    const verdict = adyenVerdict(body);
    return { verdict, ...(verdict.outcome !== 'unknown' ? { providerRef: body.pspReference } : {}) };
  } catch {
    // A timeout, malformed response, or redirect cannot prove no authorization.
    return { verdict: { outcome: 'unknown' } };
  }
}
