/**
 * Attempt ledger — the server-authoritative verdict store.
 *
 * The orchestrator mints an attemptId, the storefront page carries it into the
 * provider call, and the provider outcome is written here. The orchestrator
 * never trusts the DOM; it polls GET /api/attempts/:id.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AttemptStatus = 'created' | 'submitted' | 'succeeded' | 'declined' | 'pending' | 'error';

export interface Attempt {
  id: string;
  provider: 'stripe' | 'adyen' | 'checkout-com' | 'whop';
  amountCents: number;
  currency: string;
  simulate?: string;
  status: AttemptStatus;
  providerRef?: string;
  declineCode?: string;
  message?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const file = join(dataDir, 'attempts.json');

const attempts = new Map<string, Attempt>();

function load(): void {
  if (!existsSync(file)) return;
  try {
    const arr = JSON.parse(readFileSync(file, 'utf8')) as Attempt[];
    for (const a of arr) attempts.set(a.id, a);
  } catch {
    /* corrupt ledger → start fresh */
  }
}

function persist(): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify([...attempts.values()], null, 2));
}

load();

export function getAttempt(id: string): Attempt | undefined {
  return attempts.get(id);
}

export function upsertAttempt(input: Omit<Attempt, 'createdAt' | 'updatedAt' | 'status'> & { status?: AttemptStatus }): Attempt {
  const now = new Date().toISOString();
  const existing = attempts.get(input.id);
  const next: Attempt = {
    ...(existing ?? { createdAt: now, status: 'created' as AttemptStatus }),
    ...input,
    status: input.status ?? existing?.status ?? 'created',
    updatedAt: now,
  } as Attempt;
  attempts.set(next.id, next);
  persist();
  return next;
}

export function updateAttempt(id: string, patch: Partial<Attempt>): Attempt {
  const existing = attempts.get(id);
  if (!existing) throw new Error(`unknown attempt ${id}`);
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  attempts.set(id, next);
  persist();
  return next;
}
