/**
 * CardSource — the only way plaintext card data enters the orchestrator.
 *
 * `CardPlain` deliberately refuses to serialise: `JSON.stringify`, template
 * strings and console.log all get a redacted placeholder. The filler receives
 * the instance and reads the fields directly inside its own closure.
 */
import { redactEphemeral } from '../lib/log.js';

export interface CardMeta {
  brand?: string;
  last4: string;
  bin?: string;
  expMonth: number;
  expYear: number;
}

export class CardPlain {
  readonly number: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly cvc: string;
  readonly meta: CardMeta;

  constructor(input: { number: string; expMonth: number; expYear: number; cvc: string; brand?: string }) {
    this.number = input.number.replace(/\D/g, '');
    this.expMonth = input.expMonth;
    this.expYear = input.expYear < 100 ? 2000 + input.expYear : input.expYear;
    this.cvc = input.cvc;
    this.meta = {
      brand: input.brand,
      last4: this.number.slice(-4),
      bin: this.number.slice(0, 6),
      expMonth: this.expMonth,
      expYear: this.expYear,
    };
    redactEphemeral(this.number);
    redactEphemeral(this.cvc);
    Object.freeze(this);
  }

  /** MMYY as typed into most hosted fields. */
  get expiryMMYY(): string {
    return `${String(this.expMonth).padStart(2, '0')}${String(this.expYear).slice(-2)}`;
  }

  /** MM/YY for fields that want the slash typed. */
  get expiryMMslashYY(): string {
    return `${String(this.expMonth).padStart(2, '0')}/${String(this.expYear).slice(-2)}`;
  }

  toJSON(): never {
    throw new Error('CardPlain must never be serialised');
  }

  toString(): string {
    return `[CardPlain •••• ${this.meta.last4}]`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

export interface CardSource {
  /** Stable identifier for reports (a BT token id, a credential id…). */
  readonly id: string;
  /** Non-sensitive description for the report. */
  describe(): Promise<CardMeta>;
  /** Fetch the plaintext. Called once per attempt, result never persisted. */
  reveal(): Promise<CardPlain>;
}
