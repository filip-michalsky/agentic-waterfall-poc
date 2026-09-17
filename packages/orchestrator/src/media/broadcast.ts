import { randomUUID } from 'node:crypto';
import type { Outcome, DeclineClass, Decision } from '../cascade/policy.js';
import type { TargetId } from '../targets/types.js';
import { env, requireEnv } from '../lib/env.js';
import { logger, redact } from '../lib/log.js';

const log = logger('broadcast');
export type LiveEvent = {
  kind: 'run_started' | 'purchase_checked' | 'duplicate_blocked' | 'api_started' | 'api_result' | 'browser_started' | 'browser_navigated' | 'browser_filling' | 'browser_submitting' | 'browser_result' | 'decision' | 'run_finished' | 'run_failed';
  tier?: TargetId;
  simulated?: boolean;
  outcome?: Outcome;
  declineClass?: DeclineClass;
  decision?: Decision['next'];
  sessionId?: string;
};

/** Publish only bounded progress fields; never pass an AttemptContext or Verdict. */
export async function startBroadcast(options: { amountCents: number; currency: string; cardSource: 'vault' | 'inline' }) {
  const endpoint = new URL('/api/live', env('LIVE_DEMO_URL', 'https://soap-agentic-waterfall-demo.vercel.app'));
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1') throw new Error('LIVE_DEMO_URL must use HTTPS');
  const secret = requireEnv('LIVE_BROADCAST_SECRET', 'needed for --broadcast');
  redact(secret);
  const broadcastId = randomUUID();
  const snapshot = {
    broadcastId, revision: 0, state: 'running', startedAt: new Date().toISOString(),
    amountCents: options.amountCents, currency: options.currency.toUpperCase(), cardSource: options.cardSource,
    events: [] as Array<LiveEvent & { seq: number; at: string }>,
  };
  let queue = Promise.resolve();
  let warned = false;
  function publish(strict = false) {
    const body = JSON.stringify({ ...snapshot, revision: ++snapshot.revision });
    const job = queue.then(async () => {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Live broadcast returned HTTP ${response.status}`);
    });
    queue = job.catch((error) => {
      const status = /^Live broadcast returned HTTP \d+$/.test(error?.message) ? error.message : 'Network timeout or interruption';
      if (!warned) log.warn(`Live progress could not be delivered (${status}). The payment runner keeps its normal stop rules.`);
      warned = true;
    });
    return strict ? job : queue;
  }
  const emit = async (event: LiveEvent) => {
    // Explicit projection also prevents an accidental future object spread from
    // publishing raw responses, URLs, token IDs, or cardholder information.
    const { kind, tier, simulated, outcome, declineClass, decision, sessionId } = event;
    snapshot.events.push({ kind, tier, simulated, outcome, declineClass, decision, sessionId, seq: snapshot.events.length + 1, at: new Date().toISOString() });
    if (kind === 'run_finished' || kind === 'duplicate_blocked') snapshot.state = 'completed';
    if (kind === 'run_failed') snapshot.state = 'failed';
    await publish();
  };
  snapshot.events.push({ kind: 'run_started', seq: 1, at: snapshot.startedAt });
  await publish(true); // Fail before any attempt if the presenter cannot connect.
  log.info(`WATCH LIVE: ${new URL('/live', endpoint).href}`);
  const heartbeat = setInterval(() => { void publish(); }, 10000);
  heartbeat.unref();
  return {
    broadcastId, emit,
    async close() { clearInterval(heartbeat); await queue; },
  };
}
export type Broadcast = Awaited<ReturnType<typeof startBroadcast>>;
