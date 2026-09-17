import { createHash, timingSafeEqual } from 'node:crypto';

const tiers = ['soap', 'stripe', 'adyen', 'checkout-com', 'whop', 'adyen-api', 'checkout-com-api'];
const kinds = ['run_started', 'purchase_checked', 'duplicate_blocked', 'api_started', 'api_progress', 'api_result', 'checkout_api_started', 'checkout_api_result', 'browser_started', 'browser_navigated', 'browser_filling', 'browser_submitting', 'browser_result', 'decision', 'run_finished', 'run_failed'];
const outcomes = ['succeeded', 'declined', 'pending', 'error', 'skipped', 'unknown'];
const classes = ['insufficient_funds', 'do_not_honor', 'processor_error', 'issuer_unavailable', 'invalid_card', 'expired_card', 'incorrect_cvc', 'duplicate', 'do_not_retry', 'risk_blocked', 'fraud_hard_stop', 'authentication_required', 'unknown'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const required = (test) => { if (!test) throw new Error('Invalid live snapshot'); };

export function authorized(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const digest = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

// Only this finite vocabulary crosses the public broadcast boundary. Never pass
// through provider bodies, free-text errors, card values, tokens, or checkout URLs.
export function sanitize(input) {
  required(input && uuid.test(input.broadcastId));
  required(Number.isInteger(input.revision) && input.revision > 0);
  required(['running', 'completed', 'failed'].includes(input.state));
  required(Number.isInteger(input.amountCents) && input.amountCents > 0 && input.amountCents <= 100000);
  required(typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency));
  required(['vault', 'inline'].includes(input.cardSource));
  required(date(input.startedAt));
  required(Array.isArray(input.events) && input.events.length > 0 && input.events.length <= 80);
  const events = input.events.map((e, index) => {
    required(e && kinds.includes(e.kind) && date(e.at) && e.seq === index + 1);
    const clean = { seq: e.seq, at: e.at, kind: e.kind };
    for (const [key, values] of Object.entries({ tier: tiers, outcome: outcomes, declineClass: classes, decision: ['continue', 'stop', 'hard_stop'], captureState: ['authorized', 'captured'], apiPhase: ['request', 'proxy', 'provider'], apiAction: ['create_intent', 'verify_intent'], apiStatus: ['received', 'failed'] })) {
      if (e[key] !== undefined) { required(values.includes(e[key])); clean[key] = e[key]; }
    }
    if (e.simulated !== undefined) { required(typeof e.simulated === 'boolean'); clean.simulated = e.simulated; }
    if (e.testResponse !== undefined) { required(typeof e.testResponse === 'boolean'); clean.testResponse = e.testResponse; }
    if (e.sessionId !== undefined) { required(uuid.test(e.sessionId)); clean.sessionId = e.sessionId; }
    return clean;
  });
  const hosted = input.mode === 'on-demand' ? { mode: 'on-demand' } : {};
  return { version: 1, ...hosted, broadcastId: input.broadcastId, revision: input.revision, state: input.state, amountCents: input.amountCents, currency: input.currency, cardSource: input.cardSource, startedAt: input.startedAt, events };
}

export function canReplace(previous, next, now = Date.now()) {
  if (!previous) return true;
  if (previous.broadcastId === next.broadcastId) return next.revision > previous.revision;
  if (previous.mode === 'on-demand' && previous.state === 'running') return now > Date.parse(previous.leaseUntil);
  return previous.state !== 'running' || now - Date.parse(previous.receivedAt) > 45000;
}

export function currentBrowser(snapshot) {
  if (!snapshot || snapshot.state !== 'running') return undefined;
  for (const event of [...snapshot.events].reverse()) {
    if (['browser_result', 'api_started', 'run_finished', 'run_failed'].includes(event.kind)) return undefined;
    if (event.kind === 'browser_started') return event.sessionId;
  }
  return undefined;
}

export function safeLiveUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.browserbase.com', 'browserbase.com'].includes(url.hostname)) return undefined;
    url.searchParams.set('navbar', 'false');
    return url.href;
  } catch { return undefined; }
}

export function createHandler({ read, write, liveView, secret, now = Date.now }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => res.status(status).json(body);
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return send(405, { error: 'Method not allowed' }); }
    if (req.method === 'POST' && !authorized(req.headers.authorization, secret())) return send(401, { error: 'Broadcast authentication required' });
    try {
      if (req.method === 'POST') {
        let next;
        try {
          if (JSON.stringify(req.body).length > 24000) throw new Error();
          next = sanitize(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
        } catch { return send(400, { error: 'Invalid live snapshot' }); }
        const current = await read();
        if (!canReplace(current?.data, next, now())) return send(409, { error: 'A newer or different broadcast is active' });
        await write({ ...next, receivedAt: new Date(now()).toISOString() }, current?.etag);
        return send(200, { accepted: true });
      }
      const stored = await read();
      if (!stored) return send(200, { state: 'idle' });
      const snapshot = sanitize(stored.data);
      const receivedAt = stored.data.receivedAt;
      const stale = snapshot.state === 'running' && now() - Date.parse(receivedAt) > 45000;
      const sessionId = stale ? undefined : currentBrowser(snapshot);
      const view = sessionId ? await liveView(sessionId, snapshot.broadcastId).catch(() => ({ status: 'unavailable' })) : null;
      const retryAfter = snapshot.state === 'running' && snapshot.mode === 'on-demand' ? Math.max(0, Math.ceil((Date.parse(stored.data.leaseUntil) - now()) / 1000)) : 0;
      return send(200, { ...snapshot, receivedAt, stale, retryAfter, liveView: view });
    } catch (e) {
      const kind = e?.constructor?.name;
      if (kind === 'BlobPreconditionFailedError' || kind === 'BlobAlreadyExistsError') return send(409, { error: 'Broadcast changed; retry the update' });
      console.error(JSON.stringify({ event: 'live_feed_error', kind }));
      return send(503, { error: 'Live feed temporarily unavailable' });
    }
  };
}
