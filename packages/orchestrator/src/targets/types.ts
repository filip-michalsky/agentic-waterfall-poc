import type { Stagehand } from '@browserbasehq/stagehand';
import type { CardFiller } from '../browser/filler.js';
import type { AgentSession } from '../browser/session.js';
import type { CardMeta } from '../vault/card-source.js';
import type { Outcome } from '../cascade/policy.js';

export type TargetId = 'soap' | 'stripe' | 'adyen' | 'checkout-com' | 'whop' | 'adyen-api' | 'checkout-com-api';

export interface Shopper {
  firstName: string;
  lastName: string;
  email: string;
  postalCode: string;
  /** Adyen test env: a holder name like NOT_ENOUGH_BALANCE forces that refusal. */
  holderNameOverride?: string;
}

/**
 * One customer-authorized purchase. Every tier binds to the SAME purchase —
 * same merchant, amount, currency, terms — so the waterfall moves one order
 * across routes rather than re-pricing per tier. `purchaseId` also keys the
 * persistent double-charge ledger and the per-provider idempotency headers.
 */
export interface Purchase {
  purchaseId: string;
  merchant: string;
  amountCents: number;
  currency: string;
  /** Human description of what is being bought (for the report). */
  terms?: string;
}

export interface AttemptContext {
  runId: string;
  attemptId: string;
  amountCents: number;
  currency: string;
  simulateDecline: boolean;
  shopper: Shopper;
  cardMeta: CardMeta;
  outDir: string;
  storefrontUrl: string;
  /** The one order this whole run is authorizing (same across every tier). */
  purchase: Purchase;
  /** Idempotency key for this tier's provider call: `${purchaseId}-${tier}`. */
  idempotencyKey: string;
  /**
   * When `simulateDecline` is set on an API tier, the taxonomy code the labelled
   * simulated decline should carry (default `issuer_unavailable`, i.e. routable).
   * Use e.g. `stolen_card` to demo a hard stop or `authentication_required` for a
   * 3DS handoff. Never sent to a provider — it is a demo switch only.
   */
  simulateDeclineCode?: string;
  /**
   * The Basis Theory token id. API tiers detokenize it through the BT Proxy
   * (Liquid) and never call `reveal()`; UI tiers ignore it and type the
   * revealed card instead. Populated by the cascade loop.
   */
  tokenId?: string;
}

export interface Verdict {
  outcome: Outcome;
  providerRef?: string;
  declineCode?: string;
  message?: string;
  /**
   * Authorization vs capture are distinct states. The POC authorizes only, so a
   * winning tier is `authorized` (funds are NOT captured); the report says so and
   * never presents a capture as a generic success. `captured` is reserved for
   * future work.
   */
  captureState?: 'authorized' | 'captured';
  /** True when the provider decline was forced by a demo switch, not the issuer. */
  simulated?: boolean;
  /** What the page itself showed (LLM extract) — explanatory only. */
  pageSays?: string;
  raw?: unknown;
}

/**
 * A UI target = one provider's card form. The orchestrator drives it with a
 * browser agent:
 *   navigate → fillNonCard → fillCard → submit → verdict
 * `fillCard` is the only step that sees the filler (and thus the card).
 */
export interface UiTargetAdapter {
  id: TargetId;
  kind: 'ui';
  label: string;
  /** Returns the URL the agent opened (for the report). */
  navigate(session: AgentSession, ctx: AttemptContext): Promise<string>;
  fillNonCard(session: AgentSession, ctx: AttemptContext): Promise<void>;
  fillCard(session: AgentSession, ctx: AttemptContext, filler: CardFiller): Promise<void>;
  submit(session: AgentSession, ctx: AttemptContext): Promise<void>;
  verdict(session: AgentSession, ctx: AttemptContext): Promise<Verdict>;
}

/**
 * An API target = a provider that authorizes server-to-server. The orchestrator
 * builds the provider's own auth request with Basis Theory Liquid placeholders
 * ({{ token: <id> | json: '$.data.number' }}) and forwards it through the BT
 * ephemeral Proxy, which detokenizes and calls the provider. No browser, and
 * the PAN never enters this process — `authorize` sees only `ctx.tokenId`.
 */
export interface ApiTargetAdapter {
  id: TargetId;
  kind: 'api';
  label: string;
  authorize(ctx: AttemptContext): Promise<Verdict>;
}

export type Adapter = UiTargetAdapter | ApiTargetAdapter;

/** Back-compat alias: existing UI adapters were typed as `TargetAdapter`. */
export type TargetAdapter = UiTargetAdapter;

/**
 * A labelled, provider-free simulated decline for an API tier. No card data and
 * no network call — a demo switch only, always marked `simulated`. The code
 * drives the cascade through the real policy: `issuer_unavailable` routes on,
 * `stolen_card` hard-stops, `authentication_required`/`3ds` becomes a pending
 * 3DS handoff.
 */
export function simulatedDeclineVerdict(ctx: AttemptContext): Verdict {
  const code = ctx.simulateDeclineCode ?? 'issuer_unavailable';
  const is3ds = /3ds|authentication/i.test(code);
  return {
    outcome: is3ds ? 'pending' : 'declined',
    declineCode: code,
    simulated: true,
    message: is3ds
      ? 'simulated 3DS / authentication required (demo switch — no provider call)'
      : `simulated ${code} decline (demo switch — no provider call)`,
  };
}

/** act() with local variable substitution — values never reach the model. */
export async function actWithVars(sh: Stagehand, instruction: string, variables: Record<string, string>, attempts = 2): Promise<boolean> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const { data } = await sh.act(instruction, { variables });
      if (data?.success !== false) return true;
      last = data?.message ?? 'act reported success=false';
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  console.log(`[act] gave up: "${instruction}" — ${last.slice(0, 140)}`);
  return false;
}
