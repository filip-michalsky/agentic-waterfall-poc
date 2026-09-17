/**
 * Basis Theory ephemeral Proxy — the API-tier card path.
 *
 * Instead of revealing the PAN into this process and typing it (the UI tiers),
 * an API tier builds the provider's own authorization request with Liquid
 * placeholders and POSTs it to `${BT_API_URL}/proxy` with `BT-PROXY-URL` set to
 * the provider. Basis Theory detokenizes the `{{ token: … }}` expressions
 * server-side and forwards the request to the destination; the response comes
 * back to us. The card digits never enter this process — only the Liquid
 * strings do. This mirrors a backend forwarding
 * `cvv: {{ token: … | json: "$.data.cvc" }}` to a processor.
 *
 * Only the test tenant is reachable — `btBaseUrl()` hard-fails otherwise.
 */
import { btBaseUrl, btPrivateKey } from './basis-theory.js';
import { logger } from '../lib/log.js';

const log = logger('bt-proxy');

/** A Liquid detokenization expression for one field of a card token. */
export function liquid(tokenId: string, jsonPath: string): string {
  return `{{ token: ${tokenId} | json: '${jsonPath}' }}`;
}

/** The four card fields as Liquid, matching the JSONPaths the reveal reactor uses. */
export function cardLiquid(tokenId: string) {
  return {
    number: liquid(tokenId, '$.data.number'),
    expiration_month: liquid(tokenId, '$.data.expiration_month'),
    expiration_year: liquid(tokenId, '$.data.expiration_year'),
    cvc: liquid(tokenId, '$.data.cvc'),
  };
}

export interface BtProxyRequest {
  /** The real destination, e.g. https://checkout-test.adyen.com/v71/payments. */
  destinationUrl: string;
  method?: string;
  /** Destination auth + any other headers to forward (e.g. x-API-key, Authorization). */
  headers?: Record<string, string>;
  /** Object → JSON.stringify; string → sent verbatim (e.g. form-encoded). Carries Liquid. */
  body: unknown;
  /** Defaults to application/json. */
  contentType?: string;
}

export interface BtProxyResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

/**
 * Forward one request through the BT ephemeral proxy. Never logs the request or
 * response body (the body carries Liquid; the response can carry card metadata).
 */
export async function btProxy<T = unknown>(req: BtProxyRequest): Promise<BtProxyResponse<T>> {
  const dest = new URL(req.destinationUrl); // throws on a malformed destination
  const contentType = req.contentType ?? 'application/json';
  const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  log.info(`proxy ${req.method ?? 'POST'} → ${dest.host}${dest.pathname} (detokenizing via BT)`);
  const res = await fetch(`${btBaseUrl()}/proxy`, {
    method: req.method ?? 'POST',
    headers: {
      'BT-API-KEY': btPrivateKey(),
      'BT-PROXY-URL': req.destinationUrl,
      'Content-Type': contentType,
      Accept: 'application/json',
      ...(req.headers ?? {}),
    },
    body: payload,
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* leave as text — some errors come back non-JSON */
  }
  if (!res.ok) {
    // Status/host only; the body may echo request fragments, so keep it terse.
    log.warn(`proxy ${dest.host} → ${res.status}`);
  }
  return { status: res.status, ok: res.ok, body: parsed as T };
}
