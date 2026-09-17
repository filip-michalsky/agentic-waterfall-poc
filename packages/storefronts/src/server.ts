/**
 * The "UI-only merchants": one tiny storefront per provider, each rendering
 * that provider's hosted card fields with the SAME three container ids
 * (#card-number, #card-expiry, #card-cvc) so a single filler recipe works
 * everywhere, plus a server-side attempt ledger that is the only source of
 * truth for the orchestrator's verdict.
 *
 *   /stripe?attempt=…&amount=…&simulate=decline
 *   /adyen?…      /checkout-com?…
 *   GET /api/attempts/:id
 */
import express from 'express';
import { getAttempt } from './attempts.js';
import { stripeRouter } from './routes/stripe.js';
import { adyenRouter } from './routes/adyen.js';
import { checkoutComRouter } from './routes/checkout-com.js';
const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agentic Gateway — demo</title>
  <style>
    body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#0f1115;color:#e8eaf0}
    main{max-width:760px;margin:0 auto;padding:56px 24px}
    h1{font-size:34px;margin:0 0 8px;letter-spacing:-.5px}
    .sub{color:#9aa3b5;font-size:18px;margin-bottom:32px}
    .flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
    .step{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:14px}
    .step b{display:block;font-size:13px;color:#7cc4ff;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
    h2{font-size:18px;margin:36px 0 8px}
    ul{padding-left:20px} li{margin:6px 0} a{color:#7cc4ff}
    code{background:#171a21;padding:2px 6px;border-radius:4px;font-size:14px}
    .tag{display:inline-block;background:#1f3a2b;color:#8ee0a6;border-radius:999px;padding:2px 10px;font-size:12px;margin-left:8px;vertical-align:middle}
  </style></head><body><main>
  <h1>Agentic Gateway <span class="tag">sandbox demo</span></h1>
  <div class="sub">One customer-authorized purchase across approved API and browser payment routes, with explicit rules for when to retry and when to stop.</div>
  <div class="flow">
    <div class="step"><b>1 · vault</b>Card tokenized once with Basis Theory</div>
    <div class="step"><b>2 · tier zero</b>Soap's own processors via the backend waterfall</div>
    <div class="step"><b>3 · agentic tiers</b>the browser agent fills each provider's own checkout UI</div>
    <div class="step"><b>4 · verify</b>Read the provider outcome, record it, and apply the retry or stop policy</div>
  </div>
  <h2>The "UI-only merchants" the agent will drive</h2>
  <ul>
    <li><a href="/stripe?attempt=demo-stripe&amount=1999">Stripe</a> — split Card Elements</li>
    <li><a href="/adyen?attempt=demo-adyen&amount=1999">Adyen</a> — Custom Card securedFields</li>
    <li><a href="/checkout-com?attempt=demo-cko&amount=1999">Checkout.com</a> — Frames v2, multi-frame</li>
    <li>Whop — hosted sandbox checkout, minted per attempt</li>
  </ul>
  <h2>Audit trail</h2>
  <ul>
    <li>Server-side verdicts: <code>GET /api/attempts/:id</code></li>
    <li>Per-tier Browserbase session replays and screenshots in the run report</li>
  </ul>
  </main></body></html>`);
});

app.get('/api/attempts/:id', (req, res) => {
  const a = getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'unknown attempt' });
  res.json(a);
});

app.use('/stripe', stripeRouter);
app.use('/adyen', adyenRouter);
app.use('/checkout-com', checkoutComRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.STOREFRONT_PORT ?? 4321);
app.listen(port, () => {
  console.log(`[storefronts] listening on http://localhost:${port}  (STOREFRONT_URL=${process.env.STOREFRONT_URL ?? 'unset'})`);
});
