# Live demo

**[Open the demo](https://soap-agentic-waterfall-demo.vercel.app/live)**

One page and one viewing panel:

1. **Checkout.com API:** animate a simulated decline.
2. **Adyen API:** make a real sandbox request with a test-triggered refusal.
3. **Stripe browser:** open Browserbase, fill the test card, and authorize $19.99.
4. **Result:** confirm the authorization through Stripe’s API, then close the browser.

The API requests and responses animate in the same panel as the live browser.
**Run again** creates a new test purchase. Concurrent viewers share the active run.

## Setup

Use Node 22.23.2. This directory is the Vercel project root.

```sh
cd demo
npm ci
npm test
```

Configure these Vercel environment variables:

| Variable | Purpose |
| --- | --- |
| `ADYEN_API_KEY`, `ADYEN_MERCHANT_ACCOUNT` | Adyen test Checkout API credentials. |
| `STRIPE_SECRET_KEY` | Stripe `sk_test_` credential. |
| `STRIPE_PUBLISHABLE_KEY` | Stripe `pk_test_` key used by Stripe.js. |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | Browser sessions and Live View. |
| `OPENAI_API_KEY` | Stagehand’s form interpretation, on the server only. |
| `BLOB_READ_WRITE_TOKEN` | Private run storage. |
| `LIVE_BROADCAST_SECRET` | CLI broadcasts. |

`VERCEL_SCOPE` and `VERCEL_PROJECT` come from the root `.env` (see `.env.example`).

```sh
set -a; source ../.env; set +a
npx --yes vercel@latest link --yes --project "$VERCEL_PROJECT" --scope "$VERCEL_SCOPE"
npx --yes vercel@latest deploy --prod --yes --scope "$VERCEL_SCOPE"
```

Deployments are manual. GitHub receives code, not videos or credentials.

## What is live

Adyen uses its [documented test-card fixture](https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers)
and [response trigger](https://docs.adyen.com/development-resources/testing/result-codes)
at `https://checkout-test.adyen.com/v71/payments`. The server receives a real
`Refused / Issuer Unavailable / 9` response. This step is API-only and uses no BT Proxy.

Stripe uses real hosted Elements, Stagehand automation, and a manual-capture
PaymentIntent. The result is **authorized, not captured**. Checkout.com and
Basis Theory are illustrated here; the CLI contains their actual integrations.

All cards are provider test fixtures. The public feed contains progress and
normalized results. Secret keys, raw provider responses, and private run records
stay server-side. Stripe’s publishable key is intentionally public. The live
browser shows test card data with the CVV obscured; session recording is disabled.
