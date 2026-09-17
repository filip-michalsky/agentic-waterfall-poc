/**
 * Adyen adapter — drives Adyen's own Card component (create('card')), which
 * renders labelled cross-origin iframes for card number / expiry / security
 * code plus a plain "Name on card" input and its own Pay button, and encrypts
 * + submits through the session. Unlike the self-hosted Stripe/CKO storefronts
 * (fixed #card-number/#card-expiry/#card-cvc containers), Adyen owns the layout,
 * so we locate its iframes by title — the same enumeration strategy as Whop.
 *
 * Decline demo: Adyen test env keys refusal off the holder name, so the agent
 * types NOT_ENOUGH_BALANCE as the cardholder name when simulateDecline is set.
 */
import { join } from 'node:path';
import type { CardFiller } from '../browser/filler.js';
import { shot, sleep } from '../browser/session.js';
import { logger } from '../lib/log.js';
import { actWithVars, type AttemptContext, type TargetAdapter, type Verdict } from './types.js';
import { waitForAttempt } from './storefront.js';

const log = logger('adyen');

interface FrameInfo { index: number; title: string; name: string; src: string; x: number; y: number; w: number; h: number }

const LIST_FRAMES = `(() => Array.from(document.querySelectorAll('iframe')).map((f, index) => {
  const r = f.getBoundingClientRect();
  return { index, title: f.title || '', name: f.name || '', src: f.src || '', x: r.x, y: r.y, w: r.width, h: r.height };
}).filter(f => f.w > 30 && f.h > 12))()`;

export const adyenTarget: TargetAdapter = {
  id: 'adyen',
  kind: 'ui',
  label: 'Adyen (Card component)',

  async navigate(session, ctx) {
    const url = new URL(`${ctx.storefrontUrl}/adyen`);
    url.searchParams.set('attempt', ctx.attemptId);
    url.searchParams.set('amount', String(ctx.amountCents));
    await session.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    // Adyen renders its iframes a beat after the component mounts.
    const deadline = Date.now() + 30_000;
    let frames: FrameInfo[] = [];
    while (Date.now() < deadline) {
      frames = (await session.page.evaluate(LIST_FRAMES)) as FrameInfo[];
      if (frames.some((f) => /card ?number|encryptedCardNumber|number/i.test(`${f.title} ${f.name}`))) break;
      await sleep(1000);
    }
    if (!frames.length) throw new Error('adyen: Card component iframes never mounted');
    await sleep(800);
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-1-loaded.png`));
    return url.toString();
  },

  async fillNonCard(session, ctx) {
    const holder = ctx.simulateDecline ? 'NOT_ENOUGH_BALANCE' : `${ctx.shopper.firstName} ${ctx.shopper.lastName}`;
    // The holder-name field is a normal input inside the Adyen component.
    const ok = await actWithVars(session.sh, 'Type %holder% into the "Name on card" / cardholder name text field', { holder }, 2);
    if (!ok) {
      try {
        await session.page.locator('input[name="holderName"], input[placeholder*="J. Smith"], #card-container input[type="text"]').fill(holder);
      } catch (e) {
        log.warn(`holder name fill fallback failed: ${String(e).slice(0, 100)}`);
      }
    }
  },

  async fillCard(session, ctx, filler: CardFiller) {
    // Fill Adyen's own Card component with Stagehand act() natural language.
    // The digits ride as the hidden %value% variable, so the model sees the
    // field description but never the card data. Stagehand handles the iframe
    // traversal for the securedFields.
    await filler.actFill(session.sh, 'Fill in the card number field with %value%', 'number');
    await filler.actFill(session.sh, 'Fill in the expiry date field with %value%', 'expiry');
    await filler.actFill(session.sh, 'Fill in the security code (CVC) field with %value%', 'cvc');
    await filler.handback(session.page);
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-2-filled.png`));
  },

  async submit(session) {
    // The Card component renders its own Pay button.
    const ok = await actWithVars(session.sh, 'Click the "Pay" button that submits the Adyen card form', {}, 3);
    if (!ok) {
      try {
        const { x, y } = await session.page.locator('.adyen-checkout__button--pay, button[type="submit"]').centroid();
        await session.page.click(x, y);
      } catch (e) {
        log.warn(`pay button fallback failed: ${String(e).slice(0, 100)}`);
      }
    }
  },

  async verdict(session, ctx): Promise<Verdict> {
    const v = await waitForAttempt(ctx.storefrontUrl, ctx.attemptId, 90_000);
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
