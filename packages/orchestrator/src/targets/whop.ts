/**
 * Whop — the external, UI-only tier: a hosted checkout whose page we do NOT
 * control (unlike the Stripe/Adyen/CKO storefronts we author). Sandbox only.
 *
 *   1. mint a hosted checkout: POST /api/v1/checkout_configurations {plan_id,
 *      metadata} → { id, purchase_url }  (a localhost redirect_url is rejected,
 *      so we omit it and read the outcome from the API, not a redirect)
 *   2. the agent opens purchase_url and fills the card — act() first (digits
 *      hidden), then the CDP iframe strategy for a cross-origin hosted frame
 *   3. verdict = Whop's API (GET /api/v2/payments), matched to our checkout /
 *      metadata / plan — never the DOM.
 *
 * Sandbox: WHOP_API_URL=https://sandbox-api.whop.com/api/v1 (host must contain
 * `sandbox`); the vault's 4242 card is Whop's success test card.
 */
import { join } from 'node:path';
import type { CardFiller } from '../browser/filler.js';
import { shot, sleep } from '../browser/session.js';
import { env, requireEnv } from '../lib/env.js';
import { logger, redact } from '../lib/log.js';
import { actWithVars, type AttemptContext, type TargetAdapter, type Verdict } from './types.js';

const log = logger('whop');

interface FrameInfo {
  index: number;
  title: string;
  name: string;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const LIST_FRAMES = `(() => Array.from(document.querySelectorAll('iframe')).map((f, index) => {
  const r = f.getBoundingClientRect();
  return { index, title: f.title || '', name: f.name || '', src: f.src || '', x: r.x, y: r.y, w: r.width, h: r.height };
}).filter(f => f.w > 40 && f.h > 20))()`;

/** The sandbox host (origin), derived from WHOP_API_URL; resource paths carry their own /api/vN. */
function whopHost(): { key: string; host: string } {
  const key = requireEnv('WHOP_SANDBOX_API_KEY');
  redact(key);
  const base = env('WHOP_API_URL', 'https://sandbox-api.whop.com/api/v1')!;
  const host = new URL(base).origin;
  if (!host.includes('sandbox')) throw new Error('WHOP_API_URL must be the sandbox host (…sandbox-api.whop.com)');
  return { key, host };
}

async function whopFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { key, host } = whopHost();
  const r = await fetch(`${host}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Whop ${init.method ?? 'GET'} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const state = new Map<string, { checkoutId: string; purchaseUrl: string; planId: string; since: number }>();

export const whopTarget: TargetAdapter = {
  id: 'whop',
  kind: 'ui',
  label: 'Whop (hosted checkout, sandbox)',

  async navigate(session, ctx) {
    const planId = requireEnv('WHOP_SANDBOX_PLAN_ID');
    // No redirect_url: the sandbox rejects a localhost one, and the verdict comes
    // from the payments API, not a redirect.
    const cfg = await whopFetch<{ id: string; purchase_url: string }>('/api/v1/checkout_configurations', {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId, metadata: { attemptId: ctx.attemptId, runId: ctx.runId, source: 'agentic-waterfall-poc' } }),
    });
    state.set(ctx.attemptId, { checkoutId: cfg.id, purchaseUrl: cfg.purchase_url, planId, since: Math.floor(Date.now() / 1000) });
    log.info(`checkout ${cfg.id} → ${cfg.purchase_url}`);
    await session.page.goto(cfg.purchase_url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-1-loaded.png`));
    return cfg.purchase_url;
  },

  async fillNonCard(session, ctx) {
    // Do NOT touch the payment-method radios: "Card" is selected by default, and an
    // act() attempt to "select Card" mis-clicked "Pay with Crypto" instead. We only
    // fill the billing inputs by name, whose click points are the text inputs
    // themselves (never a method radio).
    // The billing fields are plain main-frame inputs with stable `name`s (email, name,
    // line1, city, zip, state) — Whop renders the form 3× for responsive layouts, so
    // target the VISIBLE one by name. Deterministic beats act() here: act() kept
    // mis-mapping these near-identical fields (merging name+address, leaving City empty).
    // Whop also validates the email's MX records and rejects example.com.
    const email = /@example\.(com|org|net)$/i.test(ctx.shopper.email)
      ? requireEnv('WHOP_TEST_EMAIL', 'a real mailbox — Whop validates MX records and rejects example.com')
      : ctx.shopper.email;
    const fields: Array<[string, string]> = [
      ['email', email],
      ['name', `${ctx.shopper.firstName} ${ctx.shopper.lastName}`],
      ['line1', '1 Market Street'],
      ['city', 'San Francisco'],
      ['zip', ctx.shopper.postalCode],
      ['state', 'CA'],
    ];
    // Locate the VISIBLE copy of a named input (Whop renders the form up to 3× for
    // responsive layouts, and the billing section expands as fields are filled),
    // returning its click point and current value.
    const locate = (name: string) =>
      session.page.evaluate(
        `(() => {
          const els = Array.from(document.querySelectorAll('input[name=${JSON.stringify(name)}]'));
          const el = els.find((e) => e.offsetParent !== null && e.getClientRects().length);
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x + Math.min(r.width / 2, 80), y: r.y + r.height / 2, val: el.value || '' };
        })()`,
      ) as Promise<{ x: number; y: number; val: string } | null>;

    for (const [name, value] of fields) {
      let done = false;
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        const info = await locate(name);
        if (!info) {
          await sleep(700); // field may not have rendered yet (collapsed form)
          continue;
        }
        if (info.val.trim() === value.trim()) {
          done = true;
          break;
        }
        await session.page.click(info.x, info.y);
        await session.page.keyPress('Meta+a').catch(() => {}); // select any existing content
        await session.page.type(value, { delay: 25 });
        if (name === 'state') await session.page.keyPress('Enter').catch(() => {}); // state is a combobox — commit the option
        await sleep(300);
        const after = await locate(name);
        // Verify it stuck (these are main-frame inputs, readable) — retry if not.
        if (after && after.val.replace(/\s/g, '').includes(value.replace(/\s/g, '').slice(0, 4))) done = true;
      }
      if (!done) log.warn(`whop: billing field "${name}" did not stick`);
    }
    await sleep(1200);
  },

  async fillCard(session, ctx, filler: CardFiller) {
    // Stagehand-native: observe() to RESOLVE each card field (v4 traverses Whop's
    // cross-origin Basis Theory iframes), then act() to fill the resolved element
    // (value hidden as %value%). This pre-resolves the element instead of letting a
    // free-form act() guess among the many similar inputs. A deterministic
    // coordinate fallback (by BT frame title, scrolled into view) runs only for a
    // field observe+act misses.
    const OBS = {
      number: 'the credit card number input field',
      expiry: 'the card expiration date (MM / YY) input field',
      cvc: 'the card security code (CVC or CVV) input field',
    } as const;
    const TITLE = { number: 'CardNumberElement', expiry: 'CardExpirationDateElement', cvc: 'CardVerificationCodeElement' } as const;
    for (const field of ['number', 'expiry', 'cvc'] as const) {
      if (await filler.observeActFill(session.sh, OBS[field], field)) continue;
      log.info(`observe+act missed ${field} — deterministic fallback by BT frame title`);
      await session.page.evaluate(
        `(() => { const f = Array.from(document.querySelectorAll('iframe')).find((x) => (x.title || '').includes(${JSON.stringify(TITLE[field])})); if (f) f.scrollIntoView({ block: 'center' }); })()`,
      );
      await sleep(350);
      const frames = (await session.page.evaluate(LIST_FRAMES)) as FrameInfo[];
      const fr = frames.find((f) => f.title.includes(TITLE[field]));
      if (!fr || fr.y < 0 || fr.y > 2000) {
        log.warn(`whop: ${field} frame not on-screen (${fr ? `y=${Math.round(fr.y)}` : 'not found'})`);
        continue;
      }
      await filler.typeAt(session.page, { x: fr.x + fr.w / 2, y: fr.y + Math.min(fr.h / 2, 12) }, field);
      await sleep(500);
    }
    log.info('card filled — Stagehand observe()+act() (coordinate fallback where needed)');
    await filler.handback(session.page);
  },

  async submit(session, ctx) {
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-2-filled.png`));
    // Click the purchase button DETERMINISTICALLY. act() kept clicking the
    // "Pay with Crypto" method row instead of "Join", flipping the payment method
    // and abandoning the filled card. Find the actual submit <button> by its exact
    // label text and click its centre.
    const pt = (await session.page.evaluate(
      `(() => {
        const LABELS = /^(join|pay|pay \\$?[0-9.,]+|complete purchase|subscribe|get access|purchase|checkout|place order)$/i;
        const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null && LABELS.test((b.textContent || '').trim()));
        const b = btns[btns.length - 1]; // the primary CTA sits at the bottom of the form
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (b.textContent || '').trim() };
      })()`,
    )) as { x: number; y: number; label: string } | null;
    if (!pt) throw new Error('whop: could not find the purchase (Join) button');
    log.info(`clicking purchase button "${pt.label}"`);
    await session.page.click(pt.x, pt.y);
  },

  async verdict(session, ctx): Promise<Verdict> {
    const s = state.get(ctx.attemptId);
    const deadline = Date.now() + 120_000;
    let last: unknown;
    // The sandbox has only our test traffic, so a payment for our plan created after
    // this attempt started (or carrying our attemptId/checkout id) is ours.
    const mine = (p: Record<string, unknown>): boolean => {
      const blob = JSON.stringify(p);
      if (blob.includes(ctx.attemptId) || (s && blob.includes(s.checkoutId))) return true;
      const plan = String(p.plan ?? p.plan_id ?? '');
      const created = Number(p.created_at ?? 0);
      return !!s && plan === s.planId && (created === 0 || created >= s.since - 5);
    };
    while (Date.now() < deadline) {
      try {
        const res = await whopFetch<{ data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>('/api/v2/payments?per=25');
        const list = Array.isArray(res) ? res : (res.data ?? []);
        last = list;
        const ours = list.filter(mine);
        const paid = ours.find((p) => ['paid', 'succeeded', 'completed'].includes(String(p.status).toLowerCase()));
        if (paid) {
          await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-3-result.png`));
          return { outcome: 'succeeded', captureState: 'authorized', providerRef: String(paid.id), message: `whop payment ${paid.status}`, raw: paid };
        }
        const failed = ours.find((p) => ['failed', 'declined', 'canceled', 'cancelled'].includes(String(p.status).toLowerCase()));
        if (failed) {
          await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-3-result.png`));
          return { outcome: 'declined', providerRef: String(failed.id), declineCode: String(failed.substatus ?? failed.status), raw: failed };
        }
      } catch (e) {
        log.warn(`payments poll: ${String(e).slice(0, 140)}`);
      }
      await sleep(3000);
    }
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-3-result.png`));
    let pageSays: string | undefined;
    try {
      const r = await session.sh.extract('In one sentence, what does the page say about the payment result?');
      pageSays = typeof r?.data === 'string' ? r.data : JSON.stringify(r?.data).slice(0, 200);
    } catch {
      /* explanatory only */
    }
    return { outcome: 'pending', message: 'no Whop payment observed within 120s', pageSays, raw: last };
  },
};
