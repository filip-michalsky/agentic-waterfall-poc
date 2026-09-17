/**
 * Filler smoke test — no LLM, no vault, no money.
 *
 * Serves smoke-filler.html (three iframes with one input each) from a local
 * HTTP server, opens it in a Stagehand v4 session, types a known test card
 * with the real filler, and verifies the parent page received every value via
 * postMessage — i.e. the centroid-click + type + hand-back recipe works in
 * this environment before any provider page is involved.
 *
 *   npm run smoke:filler            # local chromium
 *   STAGEHAND_ENV=BROWSERBASE …     # needs a public URL: not supported here (local server)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardPlain } from '../vault/card-source.js';
import { makeFiller } from './filler.js';
import { openSession, sleep } from './session.js';
import { logger } from '../lib/log.js';

const log = logger('smoke');
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const html = readFileSync(join(here, 'smoke-filler.html'), 'utf8');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;

  const card = new CardPlain({ number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123' });
  const filler = makeFiller(card);

  const session = await openSession({ provider: 'local', withoutModel: true });
  try {
    await session.page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    await filler.fillContainers(session.page, { number: '#card-number', expiry: '#card-expiry', cvc: '#card-cvc' });

    // The main-frame button must be clickable after hand-back.
    const btn = await session.page.locator('#pay').centroid();
    await session.page.click(btn.x, btn.y);
    await sleep(300);

    const filled = (await session.page.evaluate('window.__filled')) as Record<string, string> | undefined;
    const paid = (await session.page.evaluate('window.__paid')) as boolean | undefined;

    const ok =
      filled?.['card-number'] === card.number &&
      filled?.['card-expiry'] === card.expiryMMYY &&
      filled?.['card-cvc'] === card.cvc &&
      paid === true;

    // Deliberately compare, never print, the values.
    log.info(`number ok=${filled?.['card-number'] === card.number} expiry ok=${filled?.['card-expiry'] === card.expiryMMYY} cvc ok=${filled?.['card-cvc'] === card.cvc} paid=${paid === true}`);
    console.log(`RESULT: ${JSON.stringify({ success: ok, provider: session.provider })}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await session.close();
    server.close();
  }
}

main().catch((e) => {
  log.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
