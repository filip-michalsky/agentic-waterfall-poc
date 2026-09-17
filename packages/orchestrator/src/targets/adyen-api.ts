/**
 * Adyen — API-authorization tier (no browser).
 *
 * Builds Adyen's own /payments request and forwards it through the Basis Theory
 * ephemeral Proxy. The card number and CVC ride as Liquid placeholders and are
 * detokenized by BT server-side; they never enter this process. The expiry is
 * NOT sensitive (BT returns it in the plain token summary → ctx.cardMeta), so
 * we pass it as a literal, correctly zero-padded, rather than through Liquid.
 *
 * Decline demo: Adyen's test env refuses off the holder name, so with
 * simulateDecline we send NOT_ENOUGH_BALANCE and get resultCode=Refused —
 * exactly like the UI tier, but server-side.
 */
import { env, requireEnv } from '../lib/env.js';
import { logger } from '../lib/log.js';
import { btProxy, liquid } from '../vault/bt-proxy.js';
import { simulatedDeclineVerdict, type ApiTargetAdapter, type AttemptContext, type Verdict } from './types.js';

const log = logger('adyen-api');

interface AdyenPaymentsResponse {
  resultCode?: string;
  pspReference?: string;
  refusalReason?: string;
  refusalReasonCode?: string;
  message?: string;
  errorCode?: string;
  action?: unknown;
}

function adyenBase(): string {
  return env('ADYEN_CHECKOUT_API', 'https://checkout-test.adyen.com/v71')!.replace(/\/$/, '');
}

export const adyenApiTarget: ApiTargetAdapter = {
  id: 'adyen-api',
  kind: 'api',
  label: 'Adyen (API auth via BT Proxy)',

  async authorize(ctx: AttemptContext): Promise<Verdict> {
    if (ctx.simulateDecline) return simulatedDeclineVerdict(ctx);
    const tokenId = ctx.tokenId;
    if (!tokenId) throw new Error('adyen-api needs ctx.tokenId (the BT token to detokenize through the proxy)');
    const apiKey = requireEnv('ADYEN_API_KEY', 'Adyen test API key with the Checkout role');
    const merchantAccount = requireEnv('ADYEN_MERCHANT_ACCOUNT', 'your Adyen TEST merchant account, e.g. YourCompanyECOM');

    const holderName = ctx.simulateDecline ? 'NOT_ENOUGH_BALANCE' : `${ctx.shopper.firstName} ${ctx.shopper.lastName}`;
    const expiryMonth = ctx.cardMeta.expMonth ? String(ctx.cardMeta.expMonth).padStart(2, '0') : liquid(tokenId, '$.data.expiration_month');
    const expiryYear = ctx.cardMeta.expYear ? String(ctx.cardMeta.expYear) : liquid(tokenId, '$.data.expiration_year');

    const body = {
      merchantAccount,
      amount: { currency: ctx.currency.toUpperCase(), value: ctx.amountCents },
      reference: `awf-${ctx.attemptId}`,
      paymentMethod: {
        type: 'scheme',
        number: liquid(tokenId, '$.data.number'), // sensitive → detokenized by BT
        expiryMonth, // non-sensitive literal from the token summary
        expiryYear,
        cvc: liquid(tokenId, '$.data.cvc'), // sensitive → detokenized by BT
        holderName,
      },
      shopperReference: 'agentic-waterfall-demo',
      shopperInteraction: 'Ecommerce',
      countryCode: 'US',
    };

    let res;
    try {
      res = await btProxy<AdyenPaymentsResponse>({
        destinationUrl: `${adyenBase()}/payments`,
        method: 'POST',
        // Idempotency-Key makes a retried request to Adyen safe; the persistent
        // ledger is what prevents duplicates ACROSS providers/runs.
        headers: { 'x-API-key': apiKey, 'Idempotency-Key': ctx.idempotencyKey },
        body,
      });
    } catch (e) {
      // The request left this process but we never got a response — it may have
      // authorised. Unknown, not error: the cascade must stop and reconcile.
      return { outcome: 'unknown', message: `Adyen request sent, no response (${String((e as Error).message ?? e).slice(0, 160)})` };
    }

    const r = res.body ?? {};
    const code = r.resultCode;
    log.info(`resultCode=${code ?? `<none, http ${res.status}>`}${r.pspReference ? ` psp=${r.pspReference}` : ''}`);

    // No resultCode: a 5xx is ambiguous (could have processed) → unknown; a 4xx is a
    // definitive request/config rejection (nothing processed) → error.
    if (!code) {
      if (res.status >= 500) {
        return { outcome: 'unknown', message: `Adyen http ${res.status} (no resultCode) — outcome unknown`, raw: r };
      }
      return {
        outcome: 'error',
        message: `Adyen http ${res.status}${r.errorCode ? ` errorCode=${r.errorCode}` : ''}: ${String(r.message ?? '').slice(0, 200)}`,
        raw: r,
      };
    }

    const providerRef = r.pspReference;
    const base: Omit<Verdict, 'outcome'> = { providerRef, raw: r, message: `resultCode=${code}${r.refusalReason ? ` (${r.refusalReason})` : ''}`, simulated: ctx.simulateDecline || undefined };
    switch (code) {
      case 'Authorised':
        return { ...base, outcome: 'succeeded' };
      case 'Refused':
      case 'Error':
      case 'Cancelled':
        return { ...base, outcome: 'declined', declineCode: r.refusalReason ?? r.refusalReasonCode ?? code };
      case 'RedirectShopper':
      case 'ChallengeShopper':
      case 'IdentifyShopper':
      case 'Pending':
      case 'Received':
        return { ...base, outcome: 'pending' };
      default:
        return { ...base, outcome: 'error' };
    }
  },
};
