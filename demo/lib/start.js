import { randomUUID } from 'node:crypto';
import { canReplace } from './live-state.js';

export const DEMO_ORIGIN = 'https://soap-agentic-waterfall-demo.vercel.app';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflict = (e) => ['BlobPreconditionFailedError', 'BlobAlreadyExistsError'].includes(e?.constructor?.name);

export function configured(env = process.env) {
  return !!(env.BLOB_READ_WRITE_TOKEN && env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID && env.OPENAI_API_KEY && env.ADYEN_API_KEY && env.ADYEN_MERCHANT_ACCOUNT && env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && env.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_'));
}

export function createStartHandler({ read, write, launch, ready = configured, now = Date.now, newId = randomUUID }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const send = (code, body) => res.status(code).json(body);
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Use the Start live demo button.' }); }
    if (req.headers.origin !== DEMO_ORIGIN || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: 'Start this demo from its live page.' });
    let requestId;
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || Object.keys(body).length !== 1 || !uuid.test(body.requestId)) throw new Error();
      requestId = body.requestId;
    } catch { return send(400, { error: 'Invalid demo request.' }); }
    if (!ready()) return send(503, { error: 'The demo runner is temporarily unavailable.' });
    try {
      const current = await read();
      const previous = current?.data;
      if (previous?.requestId === requestId) return send(200, { broadcastId: previous.broadcastId, joined: true });
      const startedAt = new Date(now()).toISOString();
      const next = {
        version: 1, mode: 'on-demand', broadcastId: newId(), requestId,
        revision: 1, state: 'running', amountCents: 1999, currency: 'USD', cardSource: 'inline',
        startedAt, receivedAt: startedAt, leaseUntil: new Date(now() + 240000).toISOString(),
        events: [{ seq: 1, at: startedAt, kind: 'run_started' }],
      };
      if (!canReplace(previous, next, now())) return send(200, { broadcastId: previous.broadcastId, joined: true });
      const cooldown = previous?.mode === 'on-demand' ? Math.ceil((Date.parse(previous.startedAt) + 30000 - now()) / 1000) : 0;
      if (cooldown > 0) { res.setHeader('Retry-After', cooldown); return send(429, { error: 'Please wait a moment before starting another demo.', retryAfter: cooldown }); }
      // The conditional claim must succeed before scheduling any billable work.
      await write(next, current?.etag);
      launch(next);
      return send(202, { broadcastId: next.broadcastId, joined: false });
    } catch (e) {
      if (conflict(e)) {
        const winner = await read().catch(() => null);
        if (winner) return send(200, { broadcastId: winner.data.broadcastId, joined: true });
      }
      console.error(JSON.stringify({ event: 'demo_start_error', kind: e?.constructor?.name }));
      return send(503, { error: 'The demo could not start. Please try again.' });
    }
  };
}
