/**
 * Persistent, append-only payment ledger — the cross-run double-charge guard.
 *
 * One purchase = one `{purchaseId, merchant, amount, currency}`; the same
 * purchase carried across restarts or re-runs must never be presented to an
 * issuer twice. Before any attempt the cascade calls `blockingRecord()`; if a
 * prior attempt for this purchase is `succeeded` or `unknown` (submitted but
 * unconfirmed), the run refuses. After every attempt it calls `record()`.
 *
 * File: `<outRoot>/payments.json` (repo-level, NOT per-run) so it survives
 * restarts and separate runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Outcome } from '../cascade/policy.js';

export interface PaymentRecord {
  purchaseId: string;
  runId: string;
  tier: string;
  outcome: Outcome;
  providerRef?: string;
  idempotencyKey?: string;
  amountCents: number;
  currency: string;
  ts: string;
}

function ledgerPath(outRoot: string): string {
  return join(outRoot, 'payments.json');
}

export function loadPayments(outRoot: string): PaymentRecord[] {
  const p = ledgerPath(outRoot);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PaymentRecord[];
  } catch {
    return [];
  }
}

/**
 * A prior record for this purchase that must block a fresh attempt: a completed
 * authorization (`succeeded`) or an unresolved ambiguous one (`unknown`). Returns
 * the offending record, or undefined if it is safe to proceed.
 */
export function blockingRecord(outRoot: string, purchaseId: string): PaymentRecord | undefined {
  return loadPayments(outRoot).find((r) => r.purchaseId === purchaseId && (r.outcome === 'succeeded' || r.outcome === 'unknown'));
}

export function record(outRoot: string, rec: PaymentRecord): void {
  const p = ledgerPath(outRoot);
  mkdirSync(dirname(p), { recursive: true });
  const all = loadPayments(outRoot);
  all.push(rec);
  writeFileSync(p, JSON.stringify(all, null, 2));
}
