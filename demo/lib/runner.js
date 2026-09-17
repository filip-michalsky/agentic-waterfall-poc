import { setTimeout as pause } from 'node:timers/promises';
import { DEMO_ORIGIN, configured } from './start.js';
import { authorizeAdyen, adyenMayContinue } from './adyen.js';
import { openBrowser, loadCheckout, fillCheckout } from './browser.js';
async function stripe(path, body, idempotencyKey) {
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Test credentials required');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey } : {}) },
    ...(body ? { body: new URLSearchParams(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Stripe sandbox request failed');
  return response.json();
}

export function stripeVerdict(intent, broadcastId) {
  if (intent.livemode !== false || intent.amount !== 1999 || intent.currency !== 'usd' || intent.metadata?.demo_purchase !== broadcastId) return { outcome: 'unknown' };
  if (intent.status === 'requires_capture' && intent.capture_method === 'manual' && intent.amount_capturable === 1999) return { outcome: 'succeeded', captureState: 'authorized' };
  if (intent.status === 'requires_action' || intent.status === 'processing') return { outcome: 'pending', declineClass: 'authentication_required' };
  if (intent.status === 'requires_payment_method' && intent.last_payment_error) return { outcome: 'declined', declineClass: 'unknown' };
  return { outcome: 'unknown' };
}

export async function runDemo(initial, { read, write, archive, adyenAuthorize = authorizeAdyen, browserOpen = openBrowser, stripeRequest = stripe, wait = pause, ready = configured }) {
  let snapshot = initial, queue = Promise.resolve(), browser, intent, submitted = false, verdict;
  let tier = 'adyen-api';
  const attempts = [];
  let stage = 'starting', heartbeat;
  const publish = (event, state) => {
    queue = queue.catch(() => {}).then(async () => {
      const current = await read();
      if (current?.data.broadcastId !== initial.broadcastId) throw new Error('Demo lease lost');
      const at = new Date().toISOString();
      snapshot = { ...snapshot, revision: current.data.revision + 1, receivedAt: at, ...(state ? { state } : {}) };
      if (event) snapshot.events = [...snapshot.events, { seq: snapshot.events.length + 1, at, ...event }];
      await write(snapshot, current.etag);
    });
    return queue;
  };
  const checkoutApi = async (apiAction, path, body, idempotencyKey) => {
    await publish({ kind: 'checkout_api_started', tier: 'stripe', apiAction });
    try {
      const result = await stripeRequest(path, body, idempotencyKey);
      await publish({ kind: 'checkout_api_result', tier: 'stripe', apiAction, apiStatus: 'received' });
      // Keep the confirmed result on screen long enough to explain a fast call.
      await wait(5000);
      return result;
    } catch (e) {
      await publish({ kind: 'checkout_api_result', tier: 'stripe', apiAction, apiStatus: 'failed' }).catch(() => {});
      throw e;
    }
  };
  const record = async () => archive({ ...snapshot, tier, attempts, ...(browser ? { sessionId: browser.sessionId } : {}), ...(intent ? { providerRef: intent.id } : {}), submitted, ...(verdict ? { verdict } : {}) });
  try {
    if (!ready()) throw new Error('Sandbox runner is not configured');
    heartbeat = setInterval(() => { void publish().catch(() => {}); }, 10000);
    await publish({ kind: 'purchase_checked' });
    stage = 'api_illustration';
    await publish({ kind: 'api_started', tier: 'checkout-com-api', simulated: true });
    for (const apiPhase of ['request', 'proxy', 'provider']) {
      await publish({ kind: 'api_progress', tier: 'checkout-com-api', apiPhase, simulated: true });
      await wait(4000);
    }
    await publish({ kind: 'api_result', tier: 'checkout-com-api', outcome: 'declined', declineClass: 'issuer_unavailable', simulated: true });
    await wait(4500);
    await publish({ kind: 'decision', tier: 'checkout-com-api', outcome: 'declined', declineClass: 'issuer_unavailable', decision: 'continue', simulated: true });
    stage = 'adyen_authorize';
    const adyenEvent = { tier: 'adyen-api', simulated: false, testResponse: true };
    await publish({ kind: 'api_started', ...adyenEvent });
    await publish({ kind: 'api_progress', ...adyenEvent, apiPhase: 'request' });
    submitted = true;
    await record();
    const adyen = await adyenAuthorize(initial.broadcastId);
    verdict = adyen.verdict;
    attempts.push({ tier, submitted, verdict, providerRef: adyen.providerRef, testResponse: true });
    // A quick provider response still gets a readable request/response beat.
    await wait(3000);
    await publish({ kind: 'api_result', ...adyenEvent, ...verdict });
    await record();
    await wait(5000);
    const proceed = adyenMayContinue(verdict);
    await publish({ kind: 'decision', ...adyenEvent, ...verdict, decision: proceed ? 'continue' : verdict.outcome === 'unknown' ? 'hard_stop' : 'stop' });
    if (!proceed) return;
    tier = 'stripe'; submitted = false; verdict = undefined;
    stage = 'intent_create';
    intent = await checkoutApi('create_intent', 'payment_intents', {
      amount: '1999', currency: 'usd', capture_method: 'manual', 'payment_method_types[]': 'card',
      'metadata[demo_purchase]': initial.broadcastId, description: 'Educational live demo — test card only',
    }, `classroom-${initial.broadcastId}-stripe`);
    if (intent.livemode !== false || !intent.client_secret) throw new Error('Expected test PaymentIntent');
    stage = 'browser_create';
    browser = await browserOpen(initial.broadcastId);
    await publish({ kind: 'browser_started', tier: 'stripe', sessionId: browser.sessionId });
    await record();
    const { page } = browser;
    stage = 'browser_navigate';
    const checkout = new URL('/checkout', DEMO_ORIGIN);
    checkout.searchParams.set('key', process.env.STRIPE_PUBLISHABLE_KEY);
    checkout.searchParams.set('purchase', initial.broadcastId.slice(0, 8));
    await loadCheckout(page, checkout.href);
    await publish({ kind: 'browser_navigated', tier: 'stripe' });
    await wait(5000);
    stage = 'browser_fill';
    await publish({ kind: 'browser_filling', tier: 'stripe' });
    await fillCheckout(browser, wait);
    await wait(6000);
    // Secret stays inside the browser closure, never a URL or a broadcast event.
    await page.evaluate((clientSecret) => window.prepareDemo(clientSecret), intent.client_secret);
    await publish({ kind: 'browser_submitting', tier: 'stripe' });
    await wait(2500);
    stage = 'browser_submit';
    submitted = true;
    await record();
    await page.locator('#pay').click();
    if (!await page.waitForSelector('html[data-demo-finished="true"]', { timeout: 35000 })) throw new Error('Confirmation timed out');
    await wait(8000);
    stage = 'verify_provider';
    intent = await checkoutApi('verify_intent', `payment_intents/${intent.id}`);
    verdict = stripeVerdict(intent, initial.broadcastId);
    attempts.push({ tier, submitted, verdict, providerRef: intent.id });
    await publish({ kind: 'browser_result', tier: 'stripe', ...verdict });
    await publish({ kind: 'decision', tier: 'stripe', ...verdict, decision: verdict.outcome === 'unknown' ? 'hard_stop' : 'stop' });
  } catch (e) {
    console.error(JSON.stringify({ event: 'hosted_demo_error', broadcastId: initial.broadcastId, stage, kind: e?.constructor?.name }));
    verdict = { outcome: submitted ? 'unknown' : 'error' };
    await publish({ kind: tier === 'stripe' ? 'browser_result' : 'api_result', tier, ...verdict }).catch(() => {});
    await publish({ kind: 'decision', tier, ...verdict, decision: 'hard_stop' }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    stage = 'close';
    await browser?.close().catch(() => {});
    await publish({ kind: verdict?.outcome === 'error' ? 'run_failed' : 'run_finished' }, verdict?.outcome === 'error' ? 'failed' : 'completed').catch(() => {});
    await record().catch(() => {});
    console.info(JSON.stringify({ event: 'hosted_demo_finished', broadcastId: initial.broadcastId, sessionId: browser?.sessionId, outcome: verdict?.outcome, captureState: verdict?.captureState }));
  }
}
