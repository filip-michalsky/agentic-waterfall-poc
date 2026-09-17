/**
 * Tier zero — Soap's own rails.
 *
 * The gateway tries Soap first (API-integrated processors, the backend
 * waterfall), and only then the agentic tiers for providers with no API.
 * Recipe proven against this exact checkout on Stagehand v4:
 *   mint customer + fixed-amount checkout via the merchant API → open the
 *   checkout URL → observe our way to the card form → BT hosted fields in
 *   #card-number/#card-expiry/#card-cvc → "Add Card" → Deposit → verdict from
 *   GET /checkout_api/v1/?client_secret= (backend truth), screen as explainer.
 *
 * Env: SOAP_API_URL (sandbox, e.g. https://api-sandbox.paywithsoap.com) and
 * SOAP_API_KEY (business key). Refuses api.paywithsoap.com (production).
 */
import { join } from 'node:path';
import type { CardFiller } from '../browser/filler.js';
import { shot, sleep } from '../browser/session.js';
import { env, requireEnv } from '../lib/env.js';
import { logger, redact } from '../lib/log.js';
import { actWithVars, type AttemptContext, type TargetAdapter, type Verdict } from './types.js';

const log = logger('soap');

interface Minted {
  url: string;
  clientSecret: string;
  customerId: string;
}

const minted = new Map<string, Minted>();

function soapCfg() {
  const base = env('SOAP_API_URL', 'https://api-sandbox.paywithsoap.com')!.replace(/\/$/, '');
  if (/^https?:\/\/api\.paywithsoap\.com/.test(base)) throw new Error('SOAP_API_URL points at PRODUCTION — this POC only runs against the sandbox');
  const key = requireEnv('SOAP_API_KEY', 'a Soap sandbox business API key');
  redact(key);
  return { base, key };
}

async function soapPost<T>(path: string, body: unknown): Promise<T> {
  const { base, key } = soapCfg();
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: { error?: string; hint?: string } & Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Soap ${path} returned non-JSON (${r.status}): ${text.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`Soap ${path} ${r.status}: ${parsed.error ?? text.slice(0, 200)}${parsed.hint ? ` — ${parsed.hint}` : ''}`);
  return parsed as T;
}

async function mint(ctx: AttemptContext): Promise<Minted> {
  const { base, key } = soapCfg();
  // One stable customer per shopper email (fresh identities sharing a test card + automation device trip multi-accounting).
  // SOAP_CUSTOMER_EMAIL pins a specific pre-unrestricted customer for the demo.
  const email = env('SOAP_CUSTOMER_EMAIL') ?? ctx.shopper.email;
  const found = await fetch(`${base}/api/v1/customers/search?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${key}` } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  let customer = found?.results?.[0] ?? (Array.isArray(found) ? found[0] : (found?.customers?.[0] ?? found)) ?? null;
  if (!customer?.id && !customer?.customer_id) {
    customer = await soapPost('/api/v1/customers', {
      email,
      phone_number: `555${String(Date.now()).slice(-7)}`, // 10 digits — the docs' 11 is a known docs bug
      first_name: ctx.shopper.firstName,
      last_name: ctx.shopper.lastName,
    });
  }
  const customerId = customer.id ?? customer.customer_id;
  const checkout = await soapPost<{ client_secret: string; url: string }>('/api/v1/checkouts', {
    customer_id: customerId,
    type: 'deposit',
    fixed_amount_cents: ctx.amountCents,
  });
  return { url: checkout.url, clientSecret: checkout.client_secret, customerId };
}

async function backendState(clientSecret: string): Promise<Record<string, unknown> | null> {
  const { base } = soapCfg();
  return fetch(`${base}/checkout_api/v1/?client_secret=${clientSecret}`)
    .then((r) => r.json())
    .catch(() => null);
}

const observe = async (session: Parameters<TargetAdapter['navigate']>[0], instruction: string) => {
  try {
    const { data } = await session.sh.observe(instruction);
    return (data ?? []) as Array<{ selector: string; description: string; method?: string; arguments?: string[] }>;
  } catch {
    return [];
  }
};

const has = (session: Parameters<TargetAdapter['navigate']>[0], selector: string) =>
  session.page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);

export const soapTarget: TargetAdapter = {
  id: 'soap',
  kind: 'ui',
  label: 'Soap Payments (tier zero — API rails)',

  async navigate(session, ctx) {
    const m = await mint(ctx);
    minted.set(ctx.attemptId, m);
    log.info(`minted checkout for customer ${m.customerId}: ${m.url}`);
    await session.page.goto(m.url, { waitUntil: 'load' });
    for (let i = 0; i < 10; i++) {
      const painted = await session.page.evaluate<boolean>(`Boolean(document.body && document.body.innerText && document.body.innerText.trim().length > 40)`).catch(() => false);
      if (painted) break;
      await sleep(2000);
    }
    await sleep(1500);
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-1-loaded.png`));

    // Route to the card form: card option → "Add Another Method" → method selector row → close a modal, in that order.
    for (let step = 0; step < 6; step++) {
      if (await has(session, '#card-number')) return m.url;
      const cardOption = await observe(session, 'the "Credit / Debit Card" or "Add a card" option in a payment method list');
      const addAnother = cardOption.length ? [] : await observe(session, 'the "Add Another Method" option');
      const selectorRow = cardOption.length || addAnother.length ? [] : await observe(session, 'the Payment Method selector row showing the currently selected payment method name with a chevron');
      const closers = cardOption.length || addAnother.length || selectorRow.length ? [] : await observe(session, 'the close (X) button of an open modal or overlay dialog');
      const target = cardOption[0] ?? addAnother[0] ?? selectorRow[0] ?? closers[0];
      if (target) await session.sh.act({ ...target, method: target.method ?? 'click' }).catch(() => {});
      else await actWithVars(session.sh, 'Click the option that leads to adding a new credit or debit card', {}, 1);
      await sleep(2500);
    }
    if (!(await has(session, '#card-number'))) throw new Error('soap: never reached the card form');
    return m.url;
  },

  async fillNonCard(session, ctx) {
    const vars = { first: ctx.shopper.firstName, last: ctx.shopper.lastName, zip: ctx.shopper.postalCode };
    await actWithVars(session.sh, 'Type %first% into the First Name field', vars, 2);
    await actWithVars(session.sh, 'Type %last% into the Last Name field', vars, 2);
    const zip = await observe(session, 'the Zip or Postal Code input field on the card form');
    if (zip.length) await actWithVars(session.sh, 'Type %zip% into the Zip / Postal Code field', vars, 1);
  },

  async fillCard(session, _ctx, filler: CardFiller) {
    // Fill Soap's own Basis Theory card iframes with act() natural language
    // (digits hidden as %value%), CDP centroid filler as the fallback.
    const okNum = await filler.actFill(session.sh, 'Fill in the card number field with %value%', 'number');
    const okExp = await filler.actFill(session.sh, 'Fill in the card expiry (expiration) field with %value%', 'expiry');
    const okCvc = await filler.actFill(session.sh, 'Fill in the card CVC / security code field with %value%', 'cvc');
    if (!okNum || !okExp || !okCvc) {
      log.warn(`act() fill incomplete (num=${okNum} exp=${okExp} cvc=${okCvc}); using CDP filler`);
      await filler.fillContainers(session.page, { number: '#card-number', expiry: '#card-expiry', cvc: '#card-cvc' }, { style: 'MMYY' });
    }
    await filler.handback(session.page);
  },

  async submit(session, ctx) {
    await sleep(1200); // let BT fields validate after the last keystroke
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-2-filled.png`));
    // Soap's checkout is a single combined form whose one CTA is disabled
    // ("Please Complete Form") until the card is valid, then becomes
    // "Add Card"/"Deposit"/"Pay". Click whichever primary CTA is enabled, and
    // keep clicking as the flow advances (card → deposit → done).
    let clicks = 0;
    for (let i = 0; i < 10; i++) {
      const cta = await observe(session, 'the main enabled call-to-action button at the bottom of the form (labelled Add Card, Deposit, Pay, or Continue), not a disabled "Please Complete Form" button');
      if (cta.length) {
        await session.sh.act({ ...cta[0], method: cta[0].method ?? 'click' }).catch(() => {});
        clicks++;
        log.info(`clicked CTA: ${String(cta[0].description).slice(0, 60)}`);
        await sleep(6000);
      } else {
        await sleep(2500);
      }
      // Off the card form → the payment is progressing; hand over to verdict().
      if (!(await has(session, '#card-number')) && clicks > 0) {
        log.info('past the card form');
        return;
      }
      // A restriction / error banner means the backend refused — stop clicking,
      // let verdict() classify it (the cascade then moves to the next tier).
      const banner = (await observe(session, 'a red error or restriction banner such as "Deposit restricted", "Additional verification needed", or a decline message')).length > 0;
      if (banner && clicks > 0) {
        log.info('restriction/error banner shown — handing to verdict');
        return;
      }
    }
    log.warn('submit: card form still present after retries (form may be invalid)');
  },

  async verdict(session, ctx): Promise<Verdict> {
    const m = minted.get(ctx.attemptId);
    let screen: string | undefined;
    let outcome: Verdict['outcome'] | null = null;
    for (let i = 0; i < 14 && outcome === null; i++) {
      await sleep(5000);
      const markers = (await observe(session, 'any element that indicates the payment outcome: a success or thank-you confirmation, a "Deposit restricted" or restriction banner, a card-declined notice, an error message, an "additional verification needed" notice, or a processing spinner')).map((e) => e.description).join(' | ');
      if (markers) screen = markers.slice(0, 200);
      if (/success|thank|confirm|payment (is )?complete|deposit (is )?complete/i.test(markers)) outcome = 'succeeded';
      // "Deposit restricted" is Soap's risk engine refusing this deposit (e.g. an
      // automation customer not marked a primary account) — a decline the
      // waterfall should route past, not a hard error.
      else if (/deposit restricted|restricted|additional verification|verification needed|manual review|support team/i.test(markers)) outcome = 'declined';
      else if (/decline|do not honou?r|insufficient/i.test(markers)) outcome = 'declined';
      else if (/rejected|failure|error|failed|unable/i.test(markers)) outcome = 'error';
    }
    await shot(session.page, join(ctx.outDir, `${ctx.attemptId}-3-result.png`));
    const state = m ? await backendState(m.clientSecret) : null;
    const backendOk = !!state && (state.terminally_succeeded === true || state.completed === true || /end_screen|succeeded/.test(`${state.client_task_identifier ?? ''}${state.end_screen_identifier ?? ''}`));
    if (backendOk) return { outcome: 'succeeded', providerRef: m?.clientSecret ? `checkout ${String(m.clientSecret).slice(0, 12)}…` : undefined, message: `backend task=${state?.client_task_identifier} end_screen=${state?.end_screen_identifier}`, pageSays: screen, raw: state };
    // A Soap RISK hold (deposit restricted / additional verification / manual
    // review) must remain effective across the whole waterfall — it maps to the
    // `deposit_restricted` code, which the policy classifies as `risk_blocked`
    // and hard-stops (never bypass a risk hold by trying another gateway). Only
    // genuine processing declines (insufficient/generic) are routable.
    const isRisk = /(deposit )?restricted|additional verification|verification needed|manual review|support team/i.test(screen ?? '');
    return {
      outcome: outcome === 'succeeded' ? 'pending' : (outcome ?? 'pending'),
      declineCode: outcome === 'declined' ? (isRisk ? 'deposit_restricted' : /insufficient/i.test(screen ?? '') ? 'insufficient_funds' : 'card_declined') : undefined,
      message: `backend task=${state?.client_task_identifier ?? 'n/a'} completed=${state?.completed ?? 'n/a'}`,
      pageSays: screen,
      raw: state,
    };
  },
};
