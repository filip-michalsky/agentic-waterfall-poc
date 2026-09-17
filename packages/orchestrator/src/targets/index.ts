import type { Adapter, TargetId } from './types.js';
import { soapTarget } from './soap.js';
import { checkoutComTarget, stripeTarget } from './storefront.js';
import { adyenTarget } from './adyen.js';
import { adyenApiTarget } from './adyen-api.js';
import { checkoutComApiTarget } from './checkout-com-api.js';
import { whopTarget } from './whop.js';

export const TARGETS: Record<TargetId, Adapter> = {
  soap: soapTarget,
  stripe: stripeTarget,
  adyen: adyenTarget,
  'adyen-api': adyenApiTarget,
  'checkout-com': checkoutComTarget,
  'checkout-com-api': checkoutComApiTarget,
  whop: whopTarget,
};

/** Tier zero is Soap's own API rails; the agentic tiers follow for providers with no API. */
export const DEFAULT_TIERS: TargetId[] = ['soap', 'stripe', 'adyen', 'checkout-com', 'whop'];

export function parseTiers(spec?: string): TargetId[] {
  if (!spec) return DEFAULT_TIERS;
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean) as TargetId[];
  for (const id of ids) if (!(id in TARGETS)) throw new Error(`unknown tier "${id}" (known: ${Object.keys(TARGETS).join(', ')})`);
  return ids;
}
