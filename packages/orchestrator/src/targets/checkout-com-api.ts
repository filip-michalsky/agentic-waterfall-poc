/**
 * Checkout.com — API-authorization tier (no browser).
 *
 * Builds CKO's own /payments request and forwards it through the Basis Theory
 * ephemeral Proxy. The card number and CVV ride as Liquid placeholders and are
 * detokenized by BT server-side; they never enter this process. The expiry is
 * non-sensitive (from ctx.cardMeta) and sent as integers, as CKO expects.
 *
 * Decline demo: a REAL CKO decline can't be forced with a fixed PAN (CKO keys
 * the response off the card number, and amounts 20005/20051/20054 all authorize —
 * verified live 2026-09-07). So `--simulate-decline checkout-com-api` returns a
 * clearly-labelled `simulated` decline with NO provider call (see
 * simulatedDeclineVerdict); its code (`--simulate-decline-code`) drives the real
 * cascade policy for the demo scenarios.
 */
import { env, requireEnv } from '../lib/env.js';
import { logger } from '../lib/log.js';
import { btProxy, liquid } from '../vault/bt-proxy.js';
import { simulatedDeclineVerdict, type ApiTargetAdapter, type AttemptContext, type Verdict } from './types.js';

const log = logger('checkout-com-api');

interface CkoPaymentResponse {
  id?: string;
  approved?: boolean;
  status?: string; // Authorized | Declined | Pending | ...
  response_code?: string;
  response_summary?: string;
  error_type?: string;
  error_codes?: string[];
}

function ckoBase(): string {
  return env('CKO_API_BASE', 'https://api.sandbox.checkout.com')!.replace(/\/$/, '');
}

export const checkoutComApiTarget: ApiTargetAdapter = {
  id: 'checkout-com-api',
  kind: 'api',
  label: 'Checkout.com (API auth via BT Proxy)',

  async authorize(ctx: AttemptContext): Promise<Verdict> {
    if (ctx.simulateDecline) return simulatedDeclineVerdict(ctx);
    const tokenId = ctx.tokenId;
    if (!tokenId) throw new Error('checkout-com-api needs ctx.tokenId (the BT token to detokenize through the proxy)');
    const secretKey = requireEnv('CKO_SECRET_KEY', 'CKO sandbox secret key (sk_sbox_…) — NOT the public pk_sbox_ key');
    const processingChannelId = env('CKO_PROCESSING_CHANNEL_ID'); // optional on classic keys
    const amount = ctx.amountCents;

    const body: Record<string, unknown> = {
      source: {
        type: 'card',
        number: liquid(tokenId, '$.data.number'), // sensitive → detokenized by BT
        expiry_month: ctx.cardMeta.expMonth || undefined, // non-sensitive integer from the token summary
        expiry_year: ctx.cardMeta.expYear || undefined,
        cvv: liquid(tokenId, '$.data.cvc'), // sensitive → detokenized by BT
      },
      amount,
      currency: ctx.currency.toUpperCase(),
      reference: `awf-${ctx.purchase.purchaseId}`,
      capture: false, // authorize only — the POC never captures (see README)
      ...(processingChannelId ? { processing_channel_id: processingChannelId } : {}),
    };

    let res;
    try {
      res = await btProxy<CkoPaymentResponse>({
        destinationUrl: `${ckoBase()}/payments`,
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Cko-Idempotency-Key': ctx.idempotencyKey },
        body,
      });
    } catch (e) {
      return { outcome: 'unknown', message: `CKO request sent, no response (${String((e as Error).message ?? e).slice(0, 160)})` };
    }

    const r = res.body ?? {};
    log.info(`status=${r.status ?? `<none, http ${res.status}>`} approved=${r.approved} code=${r.response_code ?? ''}`);

    // No payment status/id: 5xx is ambiguous → unknown; 4xx is a definitive
    // validation/auth rejection (nothing processed) → error.
    if (!r.status && !r.id) {
      if (res.status >= 500) return { outcome: 'unknown', message: `CKO http ${res.status} (no payment id) — outcome unknown`, raw: r };
      return {
        outcome: 'error',
        message: `CKO http ${res.status}${r.error_type ? ` ${r.error_type}` : ''}: ${(r.error_codes ?? []).join(',').slice(0, 160)}`,
        raw: r,
      };
    }

    const providerRef = r.id;
    const base: Omit<Verdict, 'outcome'> = { providerRef, raw: r, message: `status=${r.status}${r.response_summary ? ` (${r.response_summary})` : ''}`, captureState: 'authorized' };
    if (r.approved === true || r.status === 'Authorized') return { ...base, outcome: 'succeeded' };
    if (r.status === 'Pending') return { ...base, outcome: 'pending' };
    return { ...base, outcome: 'declined', declineCode: r.response_summary ?? r.response_code ?? r.status };
  },
};
