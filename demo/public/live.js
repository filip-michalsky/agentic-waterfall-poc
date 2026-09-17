const $ = (id) => document.getElementById(id);
const frame = $('browser-frame');
const buttons = [$('start-demo'), $('start-demo-again')];
const names = { 'checkout-com-api': 'Checkout.com', 'adyen-api': 'Adyen', stripe: 'Stripe', adyen: 'Adyen', soap: 'Soap', whop: 'Whop' };
let snapshot = null, timer, polling = false, launching = false, requestId = null, cooldownUntil = 0;
let offline = false, frameLoaded = false, lastSeq = 0, forcedApi = null, forceTimer;
const human = (value) => (value || '').replaceAll('_', ' ');
const last = (kind) => snapshot?.events?.findLast((e) => e.kind === kind);
const set = (id, value) => { $(id).textContent = value; };
const amount = () => new Intl.NumberFormat('en-US', { style: 'currency', currency: snapshot?.currency || 'USD' }).format((snapshot?.amountCents || 1999) / 100);

function scene(name) {
  $('demo-stage').dataset.scene = name;
  $('api-scene').hidden = !['api', 'checkout-api', 'ready'].includes(name);
  frame.hidden = name !== 'browser';
  $('result-scene').hidden = !['result', 'status'].includes(name);
}
function caption(text) { set('phase-caption', text); }
function clearFrame() {
  frame.removeAttribute('src'); delete frame.dataset.sessionId; frameLoaded = false;
}
function attachBrowser() {
  const view = snapshot?.liveView;
  if (snapshot?.stale || view?.status !== 'running') { if (frame.getAttribute('src')) clearFrame(); return; }
  try {
    const url = new URL(view.url);
    if (url.protocol !== 'https:' || !['www.browserbase.com', 'browserbase.com'].includes(url.hostname)) throw new Error();
    if (frame.dataset.sessionId !== view.sessionId || !frame.getAttribute('src')) {
      frameLoaded = false; frame.dataset.sessionId = view.sessionId; frame.src = url.href;
    }
  } catch { clearFrame(); }
}
function apiScene(event = {}, phase = 'ready') {
  const live = event.kind?.startsWith('checkout_api_');
  const adyen = event.tier === 'adyen-api';
  const fixture = adyen && event.testResponse;
  const simulated = event.simulated || phase === 'ready' || ['run_started', 'purchase_checked'].includes(event.kind);
  const provider = live ? 'Stripe' : names[event.tier] || 'Checkout.com';
  const failed = event.apiStatus === 'failed';
  scene(live ? 'checkout-api' : phase === 'ready' ? 'ready' : 'api');
  const el = $('api-scene'); el.dataset.phase = phase; el.dataset.live = String(live || fixture); el.dataset.provider = provider;
  const retry = event.outcome === 'declined' && event.declineClass === 'issuer_unavailable';
  const nextRoute = adyen ? 'Stripe’s browser checkout' : 'Adyen’s API';
  set('stage-badge', live ? 'STRIPE API · LIVE TEST CALL' : phase === 'ready' ? 'READY TO RUN' : simulated ? 'CHECKOUT API · SIMULATED' : `${provider.toUpperCase()} API · LIVE TEST CALL`);
  set('api-kicker', live ? 'ACTUAL CHECKOUT API CALL' : fixture ? 'REAL SANDBOX CALL · TEST-TRIGGERED RESPONSE' : simulated ? 'SIMULATED API LEG' : 'API AUTHORIZATION');
  set('api-title', live ? event.apiAction === 'verify_intent' ? 'Verify the payment.' : 'Create the payment.' : phase === 'response' ? retry ? adyen ? 'API declined. Try the browser.' : 'Next: Adyen’s API.' : `${provider}: ${human(event.outcome)}.` : adyen ? 'Try Adyen through its API.' : 'Through the checkout API.');
  set('api-subtitle', live ? event.apiAction === 'verify_intent' ? 'The server reads Stripe’s result before declaring success.' : 'The server creates a test PaymentIntent for the browser.' : phase === 'response' ? retry ? `Issuer unavailable → ${nextRoute}` : 'This result stops the run.' : fixture ? 'Same $19.99 purchase. A server request, with no browser.' : 'Follow the request, then the response.');
  set('from-name', 'Orchestrator'); set('from-detail', `One purchase · ${amount()}`);
  set('via-name', live || fixture ? 'HTTPS request' : 'Basis Theory Proxy'); set('via-detail', fixture ? 'Adyen test-card fixture' : live ? 'Server → provider' : 'Token → card data');
  set('to-name', provider); set('to-detail', fixture ? 'Adyen test API' : live ? 'Stripe test API' : 'Authorization API');
  set('wire-one-label', phase === 'response' ? 'response' : 'request'); set('wire-two-label', phase === 'response' ? 'result' : 'forward');
  for (const [id, active] of [['from-node', phase === 'request'], ['via-node', phase === 'proxy'], ['to-node', ['provider', 'response'].includes(phase)]]) $(id).classList.toggle('active', active);
  $('wire-one').className = 'wire' + (['request', 'response'].includes(phase) ? ' moving' : '') + (phase === 'response' ? ' reverse' : '');
  $('wire-two').className = 'wire' + (['proxy', 'response'].includes(phase) || ((live || fixture) && phase === 'request') ? ' moving' : '') + (phase === 'response' ? ' reverse' : '');
  set('request-label', live ? event.apiAction === 'verify_intent' ? 'VERIFY' : 'CREATE' : 'REQUEST');
  set('request-code', live ? event.apiAction === 'verify_intent' ? 'GET /v1/payment_intents/:id' : `POST /v1/payment_intents · ${amount()}` : `POST ${fixture ? '/v71/payments' : '/payments'} · ${amount()} ${snapshot?.currency || 'USD'}`);
  set('request-result', phase === 'ready' ? 'Waiting to start' : phase === 'response' ? live ? failed ? 'Request failed' : 'Response received' : human(event.declineClass || event.outcome) : phase === 'provider' ? 'Awaiting response' : live ? 'Request sent' : event.simulated ? 'Illustrated request' : 'Request sent');
  if (live) caption(phase === 'response' ? failed ? 'The API request failed. The runner stops and checks the outcome.' : event.apiAction === 'verify_intent' ? 'Stripe’s response is back. Check the purchase and authorization status.' : 'PaymentIntent created. Hand its client secret to the browser’s Stripe.js.' : event.apiAction === 'verify_intent' ? 'Read the payment from Stripe’s API. A page message alone is not confirmation.' : 'Create the test payment through Stripe’s server API. No card number in this request.');
  else if (fixture) caption(phase === 'response' ? retry ? 'Adyen returned the requested sandbox refusal. Now open Stripe’s live browser.' : 'Adyen’s response does not permit a retry. No browser is launched.' : 'Send a real request to Adyen’s test API, asking its sandbox to return “Issuer Unavailable.”');
  else caption(phase === 'ready' ? 'Checkout.com API → Adyen API → live Stripe browser.' : phase === 'response' ? 'The simulated Checkout.com decline hands off to Adyen’s API. Still no browser.' : phase === 'request' ? 'Build the authorization request using a card-token placeholder.' : phase === 'proxy' ? 'The illustrated proxy substitutes card data and forwards the request.' : 'The illustrated request reaches Checkout.com. Wait for an authorization result.');
}
function statusScene(title, copy) {
  scene('status'); $('result-scene').className = 'result-scene stopped';
  set('result-icon', '·'); set('result-title', title); set('result-copy', copy);
  $('start-demo-again').hidden = true;
}
function resultScene() {
  const result = last('browser_result') || last('api_result');
  const success = result?.outcome === 'succeeded';
  scene('result'); $('result-scene').className = 'result-scene' + (success ? '' : ' stopped');
  set('stage-badge', snapshot.state === 'running' ? 'FINISHING' : 'RUN COMPLETE');
  set('result-icon', success ? '✓' : '—');
  set('result-title', success ? 'Authorized.' : result?.outcome === 'unknown' ? 'Stop. Reconcile first.' : result?.outcome === 'pending' ? 'Confirmation needed.' : 'This run stopped.');
  set('result-copy', success ? `${amount()} · provider confirmed${result.captureState === 'authorized' ? ' · not captured' : result.captureState === 'captured' ? ' · captured' : ''}` : result?.outcome === 'unknown' ? 'An unconfirmed submission must not be retried through another provider.' : 'The runner did not confirm a successful payment.');
  $('start-demo-again').hidden = false;
  caption(success ? `${names[result.tier] || 'The provider'} confirmed the test authorization.${result.captureState === 'authorized' ? ' It has not been captured.' : ' Capture status has not been verified.'}` : 'The result stops this purchase. A new demo run creates a different test purchase.');
}
function renderStage() {
  if (offline || snapshot?.stale) {
    set('stage-badge', 'FEED INTERRUPTED'); statusScene('Reconnecting…', 'Waiting for the runner. A lost stream is not a payment result.');
    caption('The demo will reconnect automatically.'); return;
  }
  if (!snapshot) { apiScene(); return; }
  if (snapshot.state !== 'running') { resultScene(); return; }
  const event = forcedApi || snapshot.events.at(-1);
  if (event.kind.startsWith('checkout_api_')) { apiScene(event, event.kind === 'checkout_api_result' ? 'response' : 'request'); return; }
  if (['run_started', 'purchase_checked', 'api_started', 'api_progress', 'api_result'].includes(event.kind) || (event.kind === 'decision' && event.decision === 'continue' && event.tier?.endsWith('-api'))) {
    apiScene(event, event.kind === 'api_result' || event.kind === 'decision' ? 'response' : event.apiPhase || 'request'); return;
  }
  if (event.kind === 'browser_result' || event.kind === 'decision') { resultScene(); return; }
  if (snapshot.liveView?.status === 'running' && frameLoaded) {
    scene('browser'); set('stage-badge', 'BROWSERBASE · LIVE BROWSER');
    caption(event.kind === 'browser_submitting' ? 'Stripe.js submits the test card through its hosted fields.' : event.kind === 'browser_filling' ? 'Stagehand fills Stripe’s checkout. The test card’s CVV is obscured.' : 'A fresh browser opens the Stripe checkout for the same purchase.');
  } else {
    set('stage-badge', 'OPENING LIVE BROWSER'); statusScene('API → browser.', snapshot.liveView?.status === 'ended' ? 'Browser ended. Waiting for the provider result.' : 'Connecting to the fresh Browserbase session…');
    caption('The API route handed off. The same purchase now continues through Stripe’s UI.');
  }
}
function renderRail() {
  const browser = last('browser_started'), result = last('browser_result') || last('api_result');
  const running = snapshot?.state === 'running';
  for (const [id, tier] of [['api', 'checkout-com-api'], ['adyen', 'adyen-api']]) {
    const api = snapshot.events.findLast((e) => e.tier === tier && e.kind === 'api_result');
    const started = snapshot.events.some((e) => e.tier === tier && e.kind === 'api_started');
    $(`route-${id}`).className = api ? api.outcome === 'succeeded' ? 'done' : 'declined' : started && running ? 'active' : '';
    set(`route-${id}-status`, api ? `${human(api.outcome)}${api.simulated ? ' · simulated' : ''}` : started && running ? 'Request in progress' : id === 'api' ? 'Simulated decline' : 'Live test API');
  }
  const browserResult = last('browser_result');
  $('route-browser').className = browserResult ? browserResult.outcome === 'succeeded' ? 'done' : 'declined' : browser && running ? 'active' : '';
  $('route-result').className = result?.outcome === 'succeeded' ? 'done' : '';
  set('route-browser-status', browserResult ? human(browserResult.outcome) : browser && running ? 'Live session' : 'Live checkout');
  set('route-result-status', result?.outcome === 'succeeded' ? result.captureState === 'authorized' ? 'Authorized · not captured' : 'Confirmed' : !running && result ? human(result.outcome) : 'Provider confirmed');
}
function updateButtons() {
  const active = snapshot?.state === 'running' && (!snapshot.stale || snapshot.retryAfter > 0);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  for (const button of buttons) {
    button.disabled = launching || active || cooldown > 0;
    button.textContent = launching ? 'Starting…' : active ? 'Running…' : cooldown ? `Wait ${cooldown}s` : snapshot ? 'Run again ↻' : 'Run live demo →';
  }
}
function render(data) {
  if (data.state === 'idle') { snapshot = null; offline = false; clearFrame(); renderStage(); updateButtons(); return; }
  if (snapshot?.broadcastId !== data.broadcastId) { lastSeq = 0; forcedApi = null; clearTimeout(forceTimer); clearFrame(); }
  snapshot = data; offline = false;
  const start = data.events.findLast((e) => e.seq > lastSeq && (e.kind === 'checkout_api_started' || (e.kind === 'api_started' && e.testResponse)));
  if (start && data.state === 'running') {
    // Fast APIs may start and finish between two feed polls. Give the request
    // its own visible beat before showing the already-received response.
    forcedApi = start; clearTimeout(forceTimer);
    forceTimer = setTimeout(() => { forcedApi = null; renderStage(); }, 1500);
  }
  lastSeq = data.events.at(-1).seq;
  attachBrowser(); renderRail(); renderStage(); updateButtons();
  set('run-reference', `${amount()} · ${data.broadcastId.slice(0, 8)}`);
}
async function poll() {
  if (document.hidden || polling) return;
  polling = true;
  try {
    const response = await fetch('/api/live', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    render(await response.json());
  } catch { offline = true; clearFrame(); renderStage(); }
  finally { polling = false; clearTimeout(timer); timer = setTimeout(poll, snapshot?.state === 'running' ? snapshot.liveView ? 1800 : 1000 : 4000); }
}
async function startDemo() {
  if (launching) return;
  launching = true; requestId ||= crypto.randomUUID(); updateButtons(); set('launch-status', '');
  try {
    const response = await fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(25000) });
    const result = await response.json();
    if (!response.ok) { cooldownUntil = Date.now() + (result.retryAfter || 0) * 1000; throw new Error(result.error || 'Could not start the demo.'); }
    requestId = null;
    if (result.joined) set('launch-status', 'Joining the current live run.');
    await poll();
    $('demo').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  } catch (e) { set('launch-status', e.name === 'TimeoutError' ? 'Start request timed out. Click again to reconnect to the same request.' : e.message); }
  finally { launching = false; updateButtons(); }
}
buttons.forEach((button) => button.addEventListener('click', startDemo));
frame.addEventListener('load', () => { if (frame.getAttribute('src')) { frameLoaded = true; renderStage(); } });
$('fullscreen').addEventListener('click', () => $('demo-stage').requestFullscreen?.().catch(() => {}));
window.addEventListener('message', (event) => {
  if (event.source === frame.contentWindow && frame.getAttribute('src') && event.origin === new URL(frame.src).origin && event.data === 'browserbase-disconnected') { clearFrame(); renderStage(); }
});
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void poll(); });
setInterval(() => {
  if (!snapshot) return;
  const end = snapshot.state === 'running' ? Date.now() : Date.parse(snapshot.events.at(-1).at);
  set('elapsed', `${Math.max(0, Math.round((end - Date.parse(snapshot.startedAt)) / 1000))}s`);
}, 1000);
void poll();
