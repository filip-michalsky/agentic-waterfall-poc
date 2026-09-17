import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunResult } from '../cascade/run.js';
import { renderMarkdown, resultLine, writeReport } from './report.js';

function interruptedPurchase(outDir = '/tmp/demo-report'): RunResult {
  return {
    runId: 'report-demo', purchaseId: 'order-42', tokenId: 'demo-token',
    startedAt: '2026-09-07T12:00:00Z', finishedAt: '2026-09-07T12:00:02Z',
    card: { brand: 'visa', last4: '4242' }, amountCents: 2499, currency: 'eur',
    tiers: ['checkout-com-api', 'stripe'], simulateDecline: ['checkout-com-api'],
    maxAttempts: 3, stopReason: 'outcome unconfirmed; reconcile before another authorization', outDir,
    attempts: [
      {
        tier: 'checkout-com-api', label: 'Checkout.com', attemptId: 'api-attempt',
        startedAt: '2026-09-07T12:00:00Z', elapsedMs: 1, provider: 'api', screenshots: [],
        verdict: { outcome: 'declined', declineCode: 'issuer_unavailable', simulated: true },
        decision: { next: 'continue', reason: 'eligible for another route' },
      },
      {
        tier: 'stripe', label: 'Stripe', attemptId: 'ui-attempt',
        startedAt: '2026-09-07T12:00:01Z', elapsedMs: 1000, provider: 'local',
        screenshots: ['/tmp/demo-report/stripe-filled.png'],
        verdict: { outcome: 'unknown', message: 'response not confirmed' },
        decision: { next: 'hard_stop', reason: 'reconcile before another authorization' },
      },
    ],
  };
}

test('payment report preserves purchase, route evidence, and reconciliation stop', () => {
  const markdown = renderMarkdown(interruptedPurchase());
  assert.match(markdown, /order-42/);
  assert.match(markdown, /24\.99 EUR/);
  assert.match(markdown, /issuer_unavailable _\(simulated\)_/);
  assert.match(markdown, /API · BT Proxy/);
  assert.match(markdown, /unknown ⚠/);
  assert.match(markdown, /hard_stop: reconcile before another authorization/);
  assert.match(markdown, /`stripe-filled\.png`/);
});

test('written report and machine-readable result work from the payment run alone', (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'waterfall-report-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const run = interruptedPurchase(outDir);
  const report = writeReport(run);
  assert.equal(readFileSync(report, 'utf8'), renderMarkdown(run));
  const result = JSON.parse(resultLine(run).replace(/^RESULT: /, ''));
  assert.deepEqual(Object.keys(result).sort(), ['attempts', 'report', 'runId', 'stopReason', 'winner']);
  assert.equal(result.winner, null);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].outcome, 'unknown');
  assert.equal(result.report, report);
  assert.equal(result.stopReason, run.stopReason);
});
