/**
 * The cascade loop: one attempt per tier (a fresh browser agent for UI tiers, a
 * server-to-server call for API tiers), stop at the first authorisation, apply
 * the decline policy between tiers.
 *
 * Safety rules (2026-09-07 review):
 *   - One Purchase is bound for the whole run; every tier authorizes the SAME
 *     order (amount/currency/merchant), not a re-priced one.
 *   - A persistent ledger (out/payments.json) blocks a second attempt on a
 *     purchase that already `succeeded` or is `unknown` — no double charge across
 *     restarts / re-runs.
 *   - An exception AFTER submission becomes `unknown` (submitted, outcome
 *     unconfirmed) → hard stop; only a pre-submission failure is `error` (retry).
 *   - Revealed card values are wiped from the logger after every attempt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFiller } from '../browser/filler.js';
import { openSession } from '../browser/session.js';
import { env } from '../lib/env.js';
import { clearEphemeral, logger, setLogFile } from '../lib/log.js';
import { TARGETS } from '../targets/index.js';
import type { AttemptContext, Purchase, Shopper, TargetId, Verdict } from '../targets/types.js';
import type { CardSource } from '../vault/card-source.js';
import { blockingRecord, record as recordPayment } from '../ledger/payments.js';
import { classifyDecline, decide, type Decision } from './policy.js';
import { startBroadcast, type Broadcast } from '../media/broadcast.js';

const log = logger('cascade');

export interface AttemptRecord {
  tier: TargetId;
  label: string;
  attemptId: string;
  url?: string;
  startedAt: string;
  elapsedMs: number;
  provider: 'local' | 'browserbase' | 'api';
  replayUrl?: string;
  sessionId?: string;
  verdict: Verdict;
  decision: Decision;
  screenshots: string[];
  error?: string;
}

export interface RunResult {
  runId: string;
  purchaseId: string;
  startedAt: string;
  finishedAt: string;
  tokenId: string;
  card: { brand?: string; last4: string; bin?: string };
  amountCents: number;
  currency: string;
  tiers: TargetId[];
  simulateDecline: TargetId[];
  maxAttempts: number;
  attempts: AttemptRecord[];
  winner?: TargetId;
  stopReason: string;
  outDir: string;
}

export interface RunOptions {
  runId: string;
  tokenId: string;
  source: CardSource;
  tiers: TargetId[];
  simulateDecline: TargetId[];
  amountCents: number;
  currency: string;
  maxAttempts: number;
  shopper: Shopper;
  outRoot: string;
  /** Stable id for the one purchase (defaults to runId). Same id across runs = same order. */
  purchaseId: string;
  merchant: string;
  /** Demo switch: throw right after submission to simulate a lost response → `unknown`. */
  injectPostSubmitFailure?: boolean;
  /** Demo switch: taxonomy code carried by a simulated API-tier decline. */
  simulateDeclineCode?: string;
  /** Share safe progress events and live Browserbase sessions with demo viewers. */
  broadcast?: boolean;
}

export async function runCascade(o: RunOptions): Promise<RunResult> {
  if (o.broadcast && o.tiers.some((tier) => TARGETS[tier].kind === 'ui') && env('STAGEHAND_ENV', 'LOCAL')!.toUpperCase() !== 'BROWSERBASE') {
    throw new Error('Broadcasting UI routes requires STAGEHAND_ENV=BROWSERBASE so viewers can see the live browser.');
  }
  const broadcast = o.broadcast ? await startBroadcast({ amountCents: o.amountCents, currency: o.currency, cardSource: o.tokenId.startsWith('inline-') ? 'inline' : 'vault' }) : undefined;
  try {
    return await executeCascade(o, broadcast);
  } catch (error) {
    await broadcast?.emit({ kind: 'run_failed' });
    throw error;
  } finally {
    await broadcast?.close();
  }
}

async function executeCascade(o: RunOptions, broadcast?: Broadcast): Promise<RunResult> {
  const outDir = join(o.outRoot, o.runId);
  mkdirSync(outDir, { recursive: true });
  setLogFile(join(outDir, 'run.log'));
  const storefrontUrl = env('STOREFRONT_URL', 'http://localhost:4321')!.replace(/\/$/, '');

  const cardMeta = await o.source.describe();
  const purchase: Purchase = {
    purchaseId: o.purchaseId,
    merchant: o.merchant,
    amountCents: o.amountCents,
    currency: o.currency,
    terms: `one deposit of ${(o.amountCents / 100).toFixed(2)} ${o.currency.toUpperCase()}`,
  };
  log.info(`run ${o.runId}: purchase ${purchase.purchaseId} — card ${cardMeta.brand ?? '?'} •••• ${cardMeta.last4}, tiers ${o.tiers.join(' → ')}, simulate-decline [${o.simulateDecline.join(', ') || 'none'}], $${(o.amountCents / 100).toFixed(2)}`);

  const result: RunResult = {
    runId: o.runId,
    purchaseId: o.purchaseId,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    tokenId: o.tokenId,
    card: { brand: cardMeta.brand, last4: cardMeta.last4, bin: cardMeta.bin },
    amountCents: o.amountCents,
    currency: o.currency,
    tiers: o.tiers,
    simulateDecline: o.simulateDecline,
    maxAttempts: o.maxAttempts,
    attempts: [],
    stopReason: 'exhausted all tiers',
    outDir,
  };

  // Cross-run / restart guard: refuse to re-present a successful or ambiguous purchase.
  const prior = blockingRecord(o.outRoot, o.purchaseId);
  if (prior) {
    await broadcast?.emit({ kind: 'duplicate_blocked' });
    result.stopReason = `purchase ${o.purchaseId} already has a ${prior.outcome} attempt (${prior.tier}${prior.providerRef ? ` ${prior.providerRef}` : ''}) — refusing to re-present; reconcile first`;
    log.warn(result.stopReason);
    result.finishedAt = new Date().toISOString();
    writeFileSync(join(outDir, 'attempts.json'), JSON.stringify(result, null, 2));
    return result;
  }
  await broadcast?.emit({ kind: 'purchase_checked' });

  let attemptsSoFar = 0;
  for (const tier of o.tiers) {
    const adapter = TARGETS[tier];
    const attemptId = `${o.runId}-${tier}`;
    const ctx: AttemptContext = {
      runId: o.runId,
      attemptId,
      amountCents: o.amountCents,
      currency: o.currency,
      simulateDecline: o.simulateDecline.includes(tier),
      shopper: o.shopper,
      cardMeta,
      outDir,
      storefrontUrl,
      tokenId: o.tokenId,
      purchase,
      idempotencyKey: `${o.purchaseId}-${tier}`,
      simulateDeclineCode: o.simulateDeclineCode,
    };
    const started = Date.now();
    log.info(`── tier ${result.attempts.length + 1}/${o.tiers.length}: ${adapter.label} (attempt ${attemptId}${ctx.simulateDecline ? ', simulated decline' : ''})`);

    const record: AttemptRecord = {
      tier,
      label: adapter.label,
      attemptId,
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      provider: 'local',
      verdict: { outcome: 'error' },
      decision: { next: 'continue', reason: '' },
      screenshots: [],
    };

    // Tracks whether we crossed the point of no return (Pay clicked / request sent).
    // A failure after this is `unknown` (maybe authorised), never a safe `error`.
    let submitted = false;

    if (adapter.kind === 'api') {
      // API tier: authorize server-to-server through the BT Proxy. No browser,
      // no reveal() — the PAN never enters this process, only Liquid strings do.
      // The adapter itself returns `unknown` on a post-send network failure; a
      // thrown error here is a pre-send config error → `error`.
      record.provider = 'api';
      await broadcast?.emit({ kind: 'api_started', tier, simulated: ctx.simulateDecline || !!o.injectPostSubmitFailure });
      try {
        // Demo switch: simulate the request leaving but the response never arriving.
        // No provider call — an honest illustration of the `unknown` hard-stop.
        if (o.injectPostSubmitFailure) {
          record.verdict = { outcome: 'unknown', message: 'injected lost response (simulated post-send failure — no provider call)' };
        } else {
          record.verdict = await adapter.authorize(ctx);
        }
      } catch (e) {
        record.error = String((e as Error).stack ?? e).slice(0, 600);
        record.verdict = { outcome: 'error', message: String((e as Error).message ?? e).slice(0, 300) };
        log.error(`${adapter.label}: ${record.verdict.message}`);
      }
      record.screenshots = [];
      await broadcast?.emit({ kind: 'api_result', tier, simulated: !!record.verdict.simulated || !!o.injectPostSubmitFailure, outcome: record.verdict.outcome, ...(record.verdict.declineCode ? { declineClass: classifyDecline(record.verdict.declineCode) } : {}) });
    } else {
      const session = await openSession({ broadcastId: broadcast?.broadcastId });
      record.provider = session.provider;
      record.replayUrl = session.replayUrl;
      record.sessionId = session.sessionId;
      try {
        await broadcast?.emit({ kind: 'browser_started', tier, sessionId: session.sessionId, simulated: ctx.simulateDecline });
        record.url = await adapter.navigate(session, ctx);
        await broadcast?.emit({ kind: 'browser_navigated', tier });
        await broadcast?.emit({ kind: 'browser_filling', tier });
        await adapter.fillNonCard(session, ctx);
        {
          // The plaintext exists only for the duration of this block.
          const card = await o.source.reveal();
          const filler = makeFiller(card);
          await adapter.fillCard(session, ctx, filler);
        }
        await broadcast?.emit({ kind: 'browser_submitting', tier });
        submitted = true; // Pay is about to be / has been clicked — point of no return
        await adapter.submit(session, ctx);
        if (o.injectPostSubmitFailure) throw new Error('injected post-submit failure (simulated lost response)');
        record.verdict = await adapter.verdict(session, ctx);
      } catch (e) {
        // After submission, an exception means the outcome is unknown, not a safe
        // "nothing happened" — a charge may have gone through.
        record.error = String((e as Error).stack ?? e).slice(0, 600);
        record.verdict = submitted
          ? { outcome: 'unknown', message: `submitted, then failed before confirmation: ${String((e as Error).message ?? e).slice(0, 200)}` }
          : { outcome: 'error', message: String((e as Error).message ?? e).slice(0, 300) };
        log.error(`${adapter.label}: ${record.verdict.outcome} — ${record.verdict.message}`);
      } finally {
        await broadcast?.emit({ kind: 'browser_result', tier, outcome: record.verdict.outcome, simulated: !!record.verdict.simulated, ...(record.verdict.declineCode ? { declineClass: classifyDecline(record.verdict.declineCode) } : {}) });
        await session.close();
      }
      record.screenshots = ['1-loaded', '2-filled', '3-result'].map((s) => join(outDir, `${attemptId}-${s}.png`));
    }

    // Wipe revealed PAN/CVC from the logger's registry now the attempt is done.
    clearEphemeral();

    // Authorize-only: a winning tier is `authorized`, not captured (see README).
    if (record.verdict.outcome === 'succeeded' && !record.verdict.captureState) record.verdict.captureState = 'authorized';

    record.elapsedMs = Date.now() - started;
    // Exposure count: everything that reached (or may have reached) the issuer counts.
    // Only a pre-submission `error` did not.
    attemptsSoFar += record.verdict.outcome === 'error' ? 0 : 1;
    record.decision = decide(record.verdict.outcome, {
      declineCode: record.verdict.declineCode,
      message: record.verdict.message,
      attemptsSoFar,
      maxAttempts: o.maxAttempts,
    });
    await broadcast?.emit({ kind: 'decision', tier, outcome: record.verdict.outcome, decision: record.decision.next, declineClass: record.decision.declineClass });
    result.attempts.push(record);
    recordPayment(o.outRoot, {
      purchaseId: o.purchaseId,
      runId: o.runId,
      tier,
      outcome: record.verdict.outcome,
      providerRef: record.verdict.providerRef,
      idempotencyKey: ctx.idempotencyKey,
      amountCents: o.amountCents,
      currency: o.currency,
      ts: new Date().toISOString(),
    });
    log.info(`${adapter.label}: ${record.verdict.outcome}${record.verdict.declineCode ? ` (${record.verdict.declineCode})` : ''} → ${record.decision.next}: ${record.decision.reason}`);
    writeFileSync(join(outDir, 'attempts.json'), JSON.stringify(result, null, 2));

    if (record.verdict.outcome === 'succeeded') {
      result.winner = tier;
      result.stopReason = `authorised at ${adapter.label}`;
      break;
    }
    if (record.decision.next !== 'continue') {
      result.stopReason = record.decision.reason;
      break;
    }
  }

  result.finishedAt = new Date().toISOString();
  await broadcast?.emit({ kind: 'run_finished' });
  writeFileSync(join(outDir, 'attempts.json'), JSON.stringify(result, null, 2));
  return result;
}
