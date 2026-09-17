/**
 * The PCI-scoped card filler.
 *
 * This is the ONLY module that types card digits into a browser. It gets a
 * `CardPlain` and closes over it; nothing here is logged, returned, or handed
 * to an LLM. The mechanics come from a proven Stagehand v4 recipe:
 *
 *   - The v4 extension world never loads inside cross-origin iframes (hosted
 *     card fields), so act/observe/locator cannot see the inputs.
 *   - Key events go to whatever holds focus regardless of frame. So: click the
 *     iframe container's centroid (a main-frame element), wait, `page.type()`.
 *   - After the last iframe field, click a neutral main-frame spot
 *     (`handback`) or every later act/observe fails ("extension world not
 *     ready for frame").
 *   - Escape before each field closes any overlay that would swallow the click.
 *
 * Two strategies:
 *   fillContainers  — one iframe per field, each inside a known container
 *                     (Stripe split elements, Adyen securedFields, CKO Frames).
 *   tabWalk         — one iframe holding several fields (Stripe Payment
 *                     Element, unknown hosted pages): click the first field,
 *                     then number ⇥ expiry ⇥ cvc.
 */
import type { Page, Stagehand } from '@browserbasehq/stagehand';
import { logger } from '../lib/log.js';
import type { CardPlain } from '../vault/card-source.js';

const log = logger('filler');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ContainerMap {
  number: string;
  expiry: string;
  cvc: string;
  /** Some forms split expiry into month + year containers. */
  expiryMonth?: string;
  expiryYear?: string;
}

export interface ExpiryFormat {
  /** 'MMYY' (default) types 1230; 'MM/YY' types 12/30; 'split' uses expiryMonth/expiryYear. */
  style: 'MMYY' | 'MM/YY' | 'split';
}

export interface CardFiller {
  fillContainers(page: Page, containers: ContainerMap, expiry?: ExpiryFormat): Promise<void>;
  tabWalk(page: Page, start: { x: number; y: number }, expiry?: ExpiryFormat, tabsBetween?: number): Promise<void>;
  typeAt(page: Page, point: { x: number; y: number }, field: 'number' | 'expiry' | 'cvc'): Promise<void>;
  /** Press Tab `tabs` times from the current focus, then type a field's value. */
  tabType(page: Page, field: 'number' | 'expiry' | 'cvc', tabs: number): Promise<void>;
  /**
   * Fill a field via Stagehand act() with natural language. The card value is
   * passed as the `%value%` variable, which Stagehand substitutes locally and
   * never sends to the model. `instruction` must contain `%value%`.
   */
  actFill(sh: Stagehand, instruction: string, field: 'number' | 'expiry' | 'cvc', attempts?: number): Promise<boolean>;
  /**
   * Stagehand-native two-step: `observe(observeInstruction)` to resolve the target
   * field (works across cross-origin iframes / shadow DOM in v4), then `act` on that
   * resolved element with the card value substituted locally as `%value%` (never
   * sent to the model). More reliable than a free-form act() because the element is
   * pre-resolved rather than guessed.
   */
  observeActFill(sh: Stagehand, observeInstruction: string, field: 'number' | 'expiry' | 'cvc', attempts?: number): Promise<boolean>;
  handback(page: Page): Promise<void>;
}

async function centroidOf(page: Page, selector: string, timeoutMs = 20_000): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      // Prefer the hosted iframe's own on-screen rect: a container can be laid
      // out while its BT/Stripe/Adyen iframe is still 0-8px tall, and clicking
      // the container centroid then lands above the real input (empty field).
      const rect = (await page.evaluate(
        `(() => {
          const host = document.querySelector(${JSON.stringify(selector)});
          if (!host) return null;
          const el = host.querySelector('iframe') || host;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
        })()`,
      )) as { x: number; y: number; w: number; h: number } | null;
      if (rect && rect.w > 20 && rect.h > 12 && Number.isFinite(rect.x) && (rect.x > 0 || rect.y > 0)) {
        return { x: rect.x, y: rect.y };
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  // Fall back to the locator centroid rather than give up outright.
  try {
    const { x, y } = await page.locator(selector).centroid();
    if (Number.isFinite(x) && (x > 0 || y > 0)) return { x, y };
  } catch (e) {
    lastErr = e;
  }
  throw new Error(`filler: ${selector} iframe never reached a clickable size — ${String(lastErr).slice(0, 120)}`);
}

async function scrollIntoView(page: Page, selector: string): Promise<void> {
  try {
    await page.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: 'center' }); })()`,
    );
  } catch {
    /* best effort */
  }
}

export function makeFiller(card: CardPlain): CardFiller {
  // Values are captured here and nowhere else.
  const valueFor = (field: 'number' | 'expiry' | 'cvc', expiry: ExpiryFormat): string => {
    if (field === 'number') return card.number;
    if (field === 'cvc') return card.cvc;
    return expiry.style === 'MM/YY' ? card.expiryMMslashYY : card.expiryMMYY;
  };

  const typeValue = async (page: Page, value: string) => {
    await page.type(value, { delay: 40 });
  };

  const clickAndType = async (page: Page, point: { x: number; y: number }, value: string, label: string) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.keyPress('Escape').catch(() => {});
        await page.click(point.x, point.y);
        await sleep(300);
        await typeValue(page, value);
        log.info(`typed ${label} (${value.length} chars) at (${Math.round(point.x)},${Math.round(point.y)})`);
        return;
      } catch (e) {
        lastErr = e;
        await sleep(1500);
      }
    }
    throw new Error(`filler: could not type ${label} — ${String(lastErr).slice(0, 160)}`);
  };

  const handback = async (page: Page) => {
    // Neutral main-frame click so Stagehand's active frame leaves the iframe.
    await page.click(5, 5).catch(() => {});
    await sleep(400);
  };

  return {
    async typeAt(page, point, field) {
      await clickAndType(page, point, valueFor(field, { style: 'MMYY' }), field);
    },

    async tabType(page, field, tabs) {
      for (let i = 0; i < tabs; i++) {
        await page.keyPress('Tab');
        await sleep(150);
      }
      await typeValue(page, valueFor(field, { style: 'MMYY' }));
      log.info(`tab×${tabs} then typed ${field}`);
    },

    async actFill(sh, instruction, field, attempts = 2) {
      if (!instruction.includes('%value%')) throw new Error('actFill instruction must contain %value%');
      // Expiry reads most naturally as MM/YY in natural language.
      const value = field === 'expiry' ? card.expiryMMslashYY : field === 'number' ? card.number : card.cvc;
      let last = '';
      for (let i = 0; i < attempts; i++) {
        try {
          const { data } = await sh.act(instruction, { variables: { value } });
          if (data?.success !== false) {
            log.info(`act-filled ${field} (${value.length} chars, value hidden from model)`);
            return true;
          }
          last = data?.message ?? 'act success=false';
        } catch (e) {
          last = String(e);
        }
        await sleep(1200 * (i + 1));
      }
      log.warn(`actFill ${field} failed: ${last.slice(0, 140)}`);
      return false;
    },

    async observeActFill(sh, observeInstruction, field, attempts = 2) {
      const value = field === 'expiry' ? card.expiryMMslashYY : field === 'number' ? card.number : card.cvc;
      let last = '';
      for (let i = 0; i < attempts; i++) {
        try {
          const obs = await sh.observe(observeInstruction);
          const el = ((obs as { data?: Array<Record<string, unknown>> })?.data ?? [])[0];
          if (!el) {
            last = 'observe found nothing';
            await sleep(1000 * (i + 1));
            continue;
          }
          // Perform the observed action, forcing a fill/type of our hidden value.
          const method = typeof el.method === 'string' && el.method !== 'click' ? el.method : 'fill';
          const { data } = await sh.act({ ...el, method, arguments: ['%value%'] } as Parameters<Stagehand['act']>[0], { variables: { value } });
          if (data?.success !== false) {
            log.info(`observe+act filled ${field} (${value.length} chars, value hidden from model)`);
            return true;
          }
          last = data?.message ?? 'act success=false';
        } catch (e) {
          last = String(e);
        }
        await sleep(1000 * (i + 1));
      }
      log.warn(`observeActFill ${field} failed: ${last.slice(0, 160)}`);
      return false;
    },

    async fillContainers(page, containers, expiry = { style: 'MMYY' }) {
      const steps: Array<{ selector: string; label: string; value: string }> = [
        { selector: containers.number, label: 'card number', value: card.number },
      ];
      if (expiry.style === 'split') {
        if (!containers.expiryMonth || !containers.expiryYear) {
          throw new Error('filler: split expiry needs expiryMonth and expiryYear containers');
        }
        steps.push({ selector: containers.expiryMonth, label: 'expiry month', value: String(card.expMonth).padStart(2, '0') });
        steps.push({ selector: containers.expiryYear, label: 'expiry year', value: String(card.expYear).slice(-2) });
      } else {
        steps.push({ selector: containers.expiry, label: 'expiry', value: valueFor('expiry', expiry) });
      }
      steps.push({ selector: containers.cvc, label: 'cvc', value: card.cvc });

      for (const step of steps) {
        await scrollIntoView(page, step.selector);
        const point = await centroidOf(page, step.selector);
        await clickAndType(page, point, step.value, step.label);
      }
      await handback(page);
    },

    async tabWalk(page, start, expiry = { style: 'MMYY' }, tabsBetween = 1) {
      await page.keyPress('Escape').catch(() => {});
      await page.click(start.x, start.y);
      await sleep(400);
      await typeValue(page, card.number);
      for (let i = 0; i < tabsBetween; i++) await page.keyPress('Tab');
      await sleep(150);
      await typeValue(page, valueFor('expiry', expiry));
      for (let i = 0; i < tabsBetween; i++) await page.keyPress('Tab');
      await sleep(150);
      await typeValue(page, card.cvc);
      log.info(`tab-walked number → expiry → cvc from (${Math.round(start.x)},${Math.round(start.y)})`);
      await handback(page);
    },

    handback,
  };
}
