import { Stagehand, browserbase } from '@browserbasehq/stagehand';
import { setTimeout as pause } from 'node:timers/promises';

export async function openBrowser(broadcastId) {
  const browser = await browserbase.launch({
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    timeout: 180,
    keepAlive: false,
    browserSettings: { recordSession: false, viewport: { width: 1000, height: 800 } },
    userMetadata: { app: 'soap-waterfall-live', broadcastId },
  });
  let stagehand;
  try {
    stagehand = await Stagehand.create({
      browser,
      model: { modelName: 'openai/gpt-4.1-mini', apiKey: process.env.OPENAI_API_KEY },
      logging: { level: 'off' },
    });
    const page = await browser.context.activePage() ?? await browser.context.newPage();
    return {
      sessionId: browser.sessionId, stagehand, page,
      async close() {
        await stagehand.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  } catch (error) {
    await stagehand?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function loadCheckout(page, url) {
  // Reload only before entering a card or preparing Stripe.js for submission.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (!response?.ok()) throw new Error('Checkout page unavailable');
      if (!await page.waitForSelector('html[data-demo-ready="true"]', { timeout: 25000 })) throw new Error('Hosted fields unavailable');
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

export async function fillCheckout({ stagehand, page }, wait = pause) {
  // Interpret the empty form before entering any card data or client secret.
  for (const [instruction, value] of [
    ['Fill the cardholder name field with %value%', 'Ada Lovelace'],
    ['Fill the postal code field with %value%', '10001'],
  ]) {
    const { data } = await stagehand.act(instruction, { variables: { value }, timeout: 20000 });
    if (data?.success !== true) throw new Error('Stagehand could not fill the checkout');
  }
  const valid = await page.evaluate(() => document.getElementById('holder').value === 'Ada Lovelace' && document.getElementById('postal').value === '10001');
  if (!valid) throw new Error('Checkout fields were not filled correctly');

  // Stagehand's native input types directly into each hosted iframe. No model
  // observations happen after this point; test PAN/CVV stay out of prompts.
  for (const [selector, value, delay] of [
    ['#card-number iframe', '4242424242424242', 170],
    ['#card-expiry iframe', '1230', 200],
    ['#card-cvc iframe', '123', 200],
  ]) {
    const { x, y } = await page.locator(selector).centroid();
    await page.click(x, y);
    await page.type(value, { delay });
    await page.click(20, 20);
    await wait(1500);
  }
}
