/**
 * Dev-only CardSource: a published TEST card passed on the command line,
 * bypassing the vault. Exists so the browser cascade can be exercised before
 * Basis Theory keys are configured. Refuses anything that is not a known
 * sandbox test PAN, and the report labels the run `vault: inline (dev)`.
 */
import { CardMeta, CardPlain, CardSource } from './card-source.js';

const KNOWN_TEST_PREFIXES = ['4242', '4000', '4111', '4012', '5555', '5200', '5105', '5385', '3782', '6011', '4917', '4988', '4166', '4646'];

export class InlineTestCardSource implements CardSource {
  readonly id: string;
  private readonly card: CardPlain;

  constructor(input: { number: string; expMonth: number; expYear: number; cvc: string }) {
    const digits = input.number.replace(/\D/g, '');
    if (!KNOWN_TEST_PREFIXES.some((p) => digits.startsWith(p))) {
      throw new Error('inline card refused: only published sandbox test PANs are accepted (4242…, 4000…, 4111…, 5555…, …)');
    }
    this.card = new CardPlain(input);
    this.id = `inline-test-card-••••${digits.slice(-4)}`;
  }

  async describe(): Promise<CardMeta> {
    return this.card.meta;
  }

  async reveal(): Promise<CardPlain> {
    return this.card;
  }
}
