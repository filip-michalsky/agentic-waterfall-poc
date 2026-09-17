/**
 * Basis Theory TEST-tenant vault.
 *
 * - tokenize(): POST /tokens type=card — the "card entered once" step.
 * - BasisTheoryCardSource.reveal(): GET /tokens/{id} — needs a private key
 *   with token:read and a `reveal` transform on the container; returns
 *   data.{number, expiration_month, expiration_year, cvc}. CVC is retained by
 *   BT for ~1h (default quota), so the cascade must run inside that window —
 *   same doctrine as a server-side processor waterfall.
 *
 * Hard guard: only api.test.basistheory.com is accepted. This POC is not PCI
 * scoped; it must never touch a production tenant.
 */
import { env, requireEnv } from '../lib/env.js';
import { logger, redact, redactEphemeral } from '../lib/log.js';
import { CardMeta, CardPlain, CardSource } from './card-source.js';

const log = logger('bt');

export const BT_TEST_HOST = 'api.test.basistheory.com';

export function btBaseUrl(): string {
  const url = env('BT_API_URL', `https://${BT_TEST_HOST}`)!;
  const host = new URL(url).host;
  if (host !== BT_TEST_HOST) {
    throw new Error(`BT_API_URL must point at ${BT_TEST_HOST} (got ${host}). This POC only runs against a test tenant.`);
  }
  return url.replace(/\/$/, '');
}

function privateKey(): string {
  const key = requireEnv('BT_TEST_PRIVATE_KEY', 'private application key with token:create, token:read + reveal transform');
  redact(key);
  return key;
}

/** The BT private application key, redacted from all logs. Used by the proxy client. */
export function btPrivateKey(): string {
  return privateKey();
}

async function btFetch<T>(path: string, init: RequestInit & { key?: string } = {}): Promise<T> {
  const res = await fetch(`${btBaseUrl()}${path}`, {
    ...init,
    headers: {
      'BT-API-KEY': init.key ?? privateKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`BT ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export interface BtTokenSummary {
  id: string;
  type: string;
  card?: { bin?: string; last4?: string; brand?: string; expiration_month?: number; expiration_year?: number };
  data?: { number?: string; expiration_month?: number; expiration_year?: number; cvc?: string };
  created_at?: string;
}

/** Tokenize a test card once. Returns the token id. */
export async function tokenize(card: { number: string; expMonth: number; expYear: number; cvc: string }): Promise<BtTokenSummary> {
  redactEphemeral(card.number);
  redactEphemeral(card.cvc);
  const body = {
    type: 'card',
    data: {
      number: card.number,
      expiration_month: card.expMonth,
      expiration_year: card.expYear < 100 ? 2000 + card.expYear : card.expYear,
      cvc: card.cvc,
    },
    metadata: { source: 'agentic-waterfall-poc' },
  };
  const token = await btFetch<BtTokenSummary>('/tokens', { method: 'POST', body: JSON.stringify(body) });
  log.info(`tokenized •••• ${token.card?.last4 ?? card.number.slice(-4)} → ${token.id}`);
  return token;
}

export class BasisTheoryCardSource implements CardSource {
  constructor(readonly id: string) {}

  async describe(): Promise<CardMeta> {
    const t = await btFetch<BtTokenSummary>(`/tokens/${this.id}`);
    return {
      brand: t.card?.brand,
      last4: t.card?.last4 ?? '????',
      bin: t.card?.bin,
      expMonth: t.card?.expiration_month ?? 0,
      expYear: t.card?.expiration_year ?? 0,
    };
  }

  /**
   * Reveal = detokenize through a tiny "echo" reactor. A plain GET /tokens/{id}
   * returns number + expiry (reveal transform) but NEVER the CVC — BT only
   * releases the CVC through detokenization (proxy or reactor), the same way
   * a backend forwards `cvv: {{ token: … | json: "$.data.cvc" }}` to a processor.
   * Needs private-app permissions: token:use, reactor:create, reactor:read.
   */
  async reveal(): Promise<CardPlain> {
    const t = await btFetch<BtTokenSummary>(`/tokens/${this.id}`);
    const reactorId = await ensureRevealReactor();
    const expr = (path: string) => `{{ token: ${this.id} | json: '${path}' }}`;
    const res = await btFetch<{ raw?: Record<string, unknown>; body?: { raw?: Record<string, unknown> } }>(`/reactors/${reactorId}/react`, {
      method: 'POST',
      body: JSON.stringify({
        args: {
          card: {
            number: expr('$.data.number'),
            expiration_month: expr('$.data.expiration_month'),
            expiration_year: expr('$.data.expiration_year'),
            cvc: expr('$.data.cvc'),
          },
        },
      }),
    });
    // node-bt runtime answers { raw }, node22 answers { res: { body } } → surfaced as { body } or { raw }
    const rawOut = (res.raw ?? res.body?.raw ?? {}) as Record<string, unknown>;
    const d = rawOut as { number?: string; expiration_month?: number | string; expiration_year?: number | string; cvc?: string };
    if (!d.number || !d.expiration_month || !d.expiration_year) {
      throw new Error(`BT reactor ${reactorId} returned no card data for token ${this.id} (keys: ${Object.keys(res).join(',') || 'none'})`);
    }
    if (!d.cvc) {
      throw new Error(
        `BT token ${this.id} has no CVC any more (retention window ~1h elapsed). Re-tokenize with \`waterfall vault\` or re-attach via tokens.update.`,
      );
    }
    log.info(`revealed •••• ${String(d.number).slice(-4)} from ${this.id} via reactor ${reactorId} (cvc present)`);
    return new CardPlain({
      number: String(d.number),
      expMonth: Number(d.expiration_month),
      expYear: Number(d.expiration_year),
      cvc: String(d.cvc),
      brand: t.card?.brand,
    });
  }
}

const REVEAL_REACTOR_NAME = 'awf-reveal';
let revealReactorId: string | undefined = env('BT_REVEAL_REACTOR_ID');

/** Find-or-create the echo reactor: `module.exports = async (req) => ({ raw: req.args.card })`. */
async function ensureRevealReactor(): Promise<string> {
  if (revealReactorId) return revealReactorId;
  try {
    const list = await btFetch<{ data?: Array<{ id: string; name: string }> }>(`/reactors?name=${REVEAL_REACTOR_NAME}`);
    const found = (list.data ?? []).find((r) => r.name === REVEAL_REACTOR_NAME);
    if (found) {
      revealReactorId = found.id;
      return found.id;
    }
    const created = await btFetch<{ id: string }>('/reactors', {
      method: 'POST',
      body: JSON.stringify({
        name: REVEAL_REACTOR_NAME,
        code: 'module.exports = async function (req) { return { raw: req.args.card }; };',
      }),
    });
    log.info(`created reveal reactor ${created.id}`);
    revealReactorId = created.id;
    return created.id;
  } catch (e) {
    throw new Error(
      `cannot find or create the BT reveal reactor: ${String((e as Error).message).slice(0, 160)} — reactor:create/read live on a MANAGEMENT application. Create it once with \`npm run bt:reactor -w packages/orchestrator\` (needs BT_TEST_MANAGEMENT_KEY) and put its id in BT_REVEAL_REACTOR_ID; the private key then only needs token:use to invoke it.`,
    );
  }
}
