/**
 * Shared adapter for the three self-hosted storefronts (Stripe, Adyen,
 * Checkout.com). They render different hosted-field iframes but expose the
 * same container ids and the same verdict API, so one adapter parameterised
 * by provider covers all three; provider-specific behaviour is a few options.
 */
import type { AgentSession } from '../browser/session.js';
import type { CardFiller, ExpiryFormat } from '../browser/filler.js';
import { sleep, shot } from '../browser/session.js';
import { logger } from '../lib/log.js';
import { actWithVars, type AttemptContext, type TargetAdapter, type TargetId, type Verdict } from './types.js';
import { join } from 'node:path';

const log = logger('target');

export interface StorefrontOptions {
  id: Exclude<TargetId, 'whop'>;
  label: string;
  path: string;
  expiry: ExpiryFormat;
  /** Name typed into the cardholder field when simulateDecline is on (Adyen trigger names). */
  simulateDeclineHolderName?: string;
  /** Whether `?simulate=decline` is honoured server-side (Stripe Radar amount, CKO amount). */
  simulateViaQuery: boolean;
}

export async function waitForAttempt(storefrontUrl: string, attemptId: string, timeoutMs: number): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${storefrontUrl}/api/attempts/${attemptId}`);
      if (r.ok) {
        last = (await r.json()) as Record<string, unknown>;
        const status = String(last.status);
        if (['succeeded', 'declined', 'error', 'pending'].includes(status)) {
          if (status === 'pending' && Date.now() < deadline - 20_000) {
            // give a 3DS / processing state a little time before calling it ambiguous
            await sleep(2000);
            continue;
          }
          return {
            outcome: status as Verdict['outcome'],
            providerRef: last.providerRef as string | undefined,
            declineCode: last.declineCode as string | undefined,
            message: last.message as string | undefined,
            raw: last.raw,
          };
        }
      }
    } catch {
      /* storefront restarting? keep polling */
    }
    await sleep(1500);
  }
  // Timed out. If the storefront ledger shows we had already submitted, the
  // outcome is unknown (a charge may have gone through) — not a safe error.
  return { outcome: last?.status === 'submitted' ? 'unknown' : 'error', message: `verdict timeout; last ledger status=${last?.status ?? 'none'}`, raw: last };
}

export function storefrontAdapter(o: StorefrontOptions): TargetAdapter {
  return {
    id: o.id,
    kind: 'ui',
    label: o.label,

    async navigate(session, ctx) {
      const url = new URL(`${ctx.storefrontUrl}${o.path}`);
      url.searchParams.set('attempt', ctx.attemptId);
      url.searchParams.set('amount', String(ctx.amountCents));
      url.searchParams.set('currency', ctx.currency);
      if (ctx.simulateDecline && o.simulateViaQuery) url.searchParams.set('simulate', 'decline');
      await session.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      // hosted fields arrive a beat after the page
      const ok = await session.page.waitForSelector('#card-number iframe', { timeout: 30_000 }).catch(() => false);
      if (!ok) throw new Error(`${o.label}: hosted card fields never mounted (check provider keys on the storefront)`);
      await sleep(800);
      await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-1-loaded.png`));
      return url.toString();
    },

    async fillNonCard(session, ctx) {
      const holder = ctx.simulateDecline && o.simulateDeclineHolderName ? o.simulateDeclineHolderName : `${ctx.shopper.firstName} ${ctx.shopper.lastName}`;
      // Agentic path with local variable substitution (values never reach the model),
      // deterministic fallback on our own page.
      const vars = { holder, email: ctx.shopper.email, postal: ctx.shopper.postalCode };
      const agentic =
        (await actWithVars(session.sh, 'Type %holder% into the cardholder name field', vars, 1)) &&
        (await actWithVars(session.sh, 'Type %email% into the email field', vars, 1)) &&
        (await actWithVars(session.sh, 'Type %postal% into the postal code field', vars, 1));
      if (!agentic) {
        log.warn(`${o.label}: act() could not fill the plain fields, using locators`);
        await session.page.locator('#cardholder-name').fill(holder);
        await session.page.locator('#email').fill(ctx.shopper.email);
        await session.page.locator('#postal').fill(ctx.shopper.postalCode);
      }
    },

    async fillCard(session, _ctx, filler: CardFiller) {
      // Fill the provider's hosted card iframes with Stagehand act() natural
      // language; the digits ride as the hidden %value% variable and never reach
      // the model. Fall back to the CDP centroid filler if act() cannot land a
      // field (some hosted-field iframes don't expose to the extension world).
      const okNum = await filler.actFill(session.sh, 'Fill in the card number field with %value%', 'number');
      const okExp = await filler.actFill(session.sh, 'Fill in the card expiry (expiration) field with %value%', 'expiry');
      const okCvc = await filler.actFill(session.sh, 'Fill in the card CVC / security code field with %value%', 'cvc');
      if (!okNum || !okExp || !okCvc) {
        log.warn(`${o.label}: act() fill incomplete (num=${okNum} exp=${okExp} cvc=${okCvc}); using CDP filler`);
        await filler.fillContainers(session.page, { number: '#card-number', expiry: '#card-expiry', cvc: '#card-cvc' }, o.expiry);
      }
      await filler.handback(session.page);
    },

    async submit(session, ctx) {
      await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-2-filled.png`));
      let clicked = false;
      try {
        const { data } = await session.sh.observe('the Pay button that submits the payment form');
        const el = (data ?? [])[0];
        if (el) {
          const r = await session.sh.act({ ...el, method: el.method ?? 'click' });
          clicked = r.data?.success !== false;
        }
      } catch (e) {
        log.warn(`${o.label}: observe/act on Pay failed: ${String(e).slice(0, 100)}`);
      }
      if (!clicked) {
        const { x, y } = await session.page.locator('#pay').centroid();
        await session.page.click(x, y);
      }
    },

    async verdict(session, ctx) {
      const v = await waitForAttempt(ctx.storefrontUrl, ctx.attemptId, 90_000);
      if (ctx.simulateDecline && v.outcome === 'declined') v.simulated = true;
      await sleep(500);
      await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-3-result.png`));
      try {
        const status = await session.page.evaluate('document.getElementById("status") && document.getElementById("status").textContent');
        v.pageSays = typeof status === 'string' ? status.slice(0, 200) : undefined;
      } catch {
        /* explanatory only */
      }
      return v;
    },
  };
}

export const stripeTarget = storefrontAdapter({
  id: 'stripe',
  label: 'Stripe (split Card Elements)',
  path: '/stripe',
  expiry: { style: 'MMYY' },
  simulateViaQuery: true,
});


// Checkout.com's sandbox simulates response codes only via dedicated test card
// numbers, never via amount or holder name — with the same PAN across the
// cascade a CKO decline cannot be forced. `--simulate-decline checkout-com`
// is therefore recorded as unsupported (the report says so) and the tier
// behaves normally.
export const checkoutComTarget = storefrontAdapter({
  id: 'checkout-com',
  label: 'Checkout.com (Frames v2)',
  path: '/checkout-com',
  expiry: { style: 'MMYY' },
  simulateViaQuery: false,
});
