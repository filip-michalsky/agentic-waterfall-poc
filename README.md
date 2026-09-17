# Agentic Gateway

## [Run the live demo →](https://soap-agentic-waterfall-demo.vercel.app/live)

Watch a $19.99 test purchase move from **Checkout.com API → Adyen API → Stripe browser** in one view.

- **Checkout.com:** animated API request and simulated decline.
- **Adyen:** real sandbox API request with a test-triggered refusal.
- **Stripe:** Stagehand drives a live Browserbase checkout, then Stripe’s API confirms the authorization. No capture.

Click **Run again** for a fresh demo. Email updates are optional. Test cards only; no real money.

[Animated diagram](packages/orchestrator/media/payment-flow.svg) · [Setup and deployment](demo/README.md)

## Sandboxes

Adyen uses `checkout-test.adyen.com`; Stripe uses test keys and hosted Elements.
The CLI also uses Checkout.com’s sandbox and Basis Theory’s test vault/proxy.
Those two services are illustrated in the hosted demo. Browserbase provides the live browser.

## Reels

The 36-second exports are in `packages/orchestrator/out/reel/`:
`reel-16x9.mp4`, `reel-1x1.mp4`, and `reel-9x16.mp4`.
Both API steps are animated; Stripe uses recorded sandbox footage. Only the CVV is pixelated.

[Rebuild the reels](packages/orchestrator/media/REEL-STORY.md). Videos stay local, outside Git.

## Code

`demo/` hosts the live experience. `packages/orchestrator/` contains the CLI and reel tooling.
`packages/storefronts/` contains local checkout pages. Use Node 22.23.2.

Secret credentials stay server-side and outside Git. [CLI environment template](.env.example).
