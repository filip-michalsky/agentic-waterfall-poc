/**
 * Cascade policy — which tier next, when to stop.
 *
 * Follows a standard processor-waterfall decline taxonomy, with two safety rules
 * the first cut got wrong (2026-09-07 review):
 *
 *   1. Classify the STRUCTURED code first, free-text message only as a fallback —
 *      so `stolen_card` + "Your card was declined." is a fraud hard-stop, not a
 *      generic decline. Generic `declined|refused|do_not_honor` patterns sit LAST.
 *   2. `unknown` (submitted, outcome unconfirmed) is a HARD STOP: never present the
 *      same purchase to another gateway until it is reconciled (no double-charge).
 *
 * Taxonomy:
 *   - insufficient_funds / do_not_honor / processor_error / issuer_unavailable → next tier
 *   - invalid_card / expired_card / incorrect_cvc / duplicate → stop (the card is wrong)
 *   - do_not_retry (network advice "do not try again") → stop
 *   - risk_blocked (Soap risk hold) → HARD STOP across the whole waterfall
 *   - pickup / stolen / lost / fraud → HARD STOP, never re-present
 *   - authentication_required / 3DS → stop and surface (explicit customer handoff)
 *   - pending / timeout → stop and surface
 *   - unknown (submitted, no confirmation) → HARD STOP, reconcile
 *   - attempt cap per PAN per run (≤3 by default)
 */
export type Outcome = 'succeeded' | 'declined' | 'pending' | 'error' | 'skipped' | 'unknown';

export type DeclineClass =
  | 'insufficient_funds'
  | 'do_not_honor'
  | 'processor_error'
  | 'issuer_unavailable'
  | 'invalid_card'
  | 'expired_card'
  | 'incorrect_cvc'
  | 'duplicate'
  | 'do_not_retry'
  | 'risk_blocked'
  | 'fraud_hard_stop'
  | 'authentication_required'
  | 'unknown';

export type Decision = { next: 'continue' | 'stop' | 'hard_stop'; reason: string; declineClass?: DeclineClass };

/**
 * Provider decline strings → taxonomy class, most-specific / hardest FIRST so a
 * generic word can never override a specific code. Applied to the structured
 * `code` first, then (only if that is unclassified) to the free-text message.
 */
const CLASS_BY_CODE: Array<[RegExp, DeclineClass]> = [
  // Soap risk holds — must remain effective across the waterfall (checked before fraud
  // so "deposit_restricted" is a risk hold, not a bare "restricted" fraud match).
  [/deposit[_ ]?restricted|risk[_ ]?blocked|risk[_ ]?hold|additional[_ ]?verification|verification[_ ]?needed|manual[_ ]?review/i, 'risk_blocked'],
  // Fraud / pickup / stolen — hard stop.
  [/pick[_ ]?up|\bpickup\b|stolen|lost[_ ]?card|\blost\b|fraud|security[_ ]?violation|restricted[_ ]?card|\b41\b|\b43\b/i, 'fraud_hard_stop'],
  // Network advice: do not retry this transaction.
  [/do[_ ]?not[_ ]?(try[_ ]?again|retry)|\bdo_not_try_again\b|no[_ ]?retry/i, 'do_not_retry'],
  // The credential itself is wrong.
  [/incorrect[_ ]?number|invalid[_ ]?number|invalid[_ ]?card|card[_ ]?not[_ ]?supported|\b14\b/i, 'invalid_card'],
  [/expired[_ ]?card|card[_ ]?expired|\bexpired\b|\b54\b/i, 'expired_card'],
  [/incorrect[_ ]?cvc|invalid[_ ]?cvc|cvc[_ ]?declined|\bcvc\b|\bcvv\b/i, 'incorrect_cvc'],
  [/duplicate/i, 'duplicate'],
  // Issuer wants authentication — surface for handoff, do not cascade silently.
  [/authentication[_ ]?required|3ds|three[_ ]?d[_ ]?secure|\bchallenge\b|identifyshopper|redirectshopper|challengeshopper/i, 'authentication_required'],
  // Soft, retry-eligible at another acquirer.
  [/issuer[_ ]?unavailable|issuer.*unavailable|\b91\b/i, 'issuer_unavailable'],
  [/insufficient|not[_ ]?enough[_ ]?balance|\b51\b/i, 'insufficient_funds'],
  [/processing[_ ]?error|processor[_ ]?error|try[_ ]?again[_ ]?later|acquirer[_ ]?error|\binternal\b/i, 'processor_error'],
  // Generic decline — LAST, only when nothing specific matched.
  [/do[_ ]?not[_ ]?honou?r|generic[_ ]?decline|\bdeclined\b|\brefused\b|refusal|\b05\b/i, 'do_not_honor'],
];

function classifyOne(hay: string): DeclineClass | undefined {
  for (const [re, cls] of CLASS_BY_CODE) if (re.test(hay)) return cls;
  return undefined;
}

/** Structured code wins; free-text message is only a fallback. */
export function classifyDecline(code?: string, message?: string): DeclineClass {
  const c = (code ?? '').trim();
  const m = (message ?? '').trim();
  return (c && classifyOne(c)) || (m && classifyOne(m)) || 'unknown';
}

export function decide(outcome: Outcome, opts: { declineCode?: string; message?: string; attemptsSoFar: number; maxAttempts: number }): Decision {
  if (outcome === 'succeeded') return { next: 'stop', reason: 'authorised' };
  // Submitted but never confirmed: a provider may have authorised and the response
  // vanished. Never present the same purchase elsewhere until reconciled.
  if (outcome === 'unknown') return { next: 'hard_stop', reason: 'submitted but outcome unconfirmed — reconcile before any further authorization' };
  if (outcome === 'pending') return { next: 'stop', reason: 'ambiguous outcome (pending/3DS/timeout) — surface, do not re-present' };
  if (outcome === 'skipped') return { next: 'continue', reason: 'tier skipped' };
  if (opts.attemptsSoFar >= opts.maxAttempts) {
    return { next: 'stop', reason: `attempt cap reached (${opts.maxAttempts} per PAN per run)` };
  }
  const declineClass = classifyDecline(opts.declineCode, opts.message);
  switch (declineClass) {
    case 'fraud_hard_stop':
      return { next: 'hard_stop', reason: 'pickup/stolen/fraud signal — terminate and flag', declineClass };
    case 'risk_blocked':
      return { next: 'hard_stop', reason: 'Soap risk hold — must remain effective, do not try another gateway', declineClass };
    case 'do_not_retry':
      return { next: 'stop', reason: 'network advice: do not retry this transaction', declineClass };
    case 'invalid_card':
    case 'expired_card':
    case 'incorrect_cvc':
    case 'duplicate':
      return { next: 'stop', reason: `${declineClass}: the credential itself is wrong, another gateway will not fix it`, declineClass };
    case 'authentication_required':
      return { next: 'stop', reason: 'issuer wants authentication — surface to the user (handoff), do not cascade silently', declineClass };
    case 'insufficient_funds':
      // Retry-eligible at another acquirer, but changing processors does not replenish
      // the account — network-advice retry only, still bounded by the attempt cap.
      return { next: 'continue', reason: 'insufficient_funds: network-advice retry at the next acquirer (cap applies)', declineClass };
    case 'do_not_honor':
    case 'processor_error':
    case 'issuer_unavailable':
      return { next: 'continue', reason: `${declineClass}: retry-eligible at the next tier`, declineClass };
    case 'unknown':
    default:
      // A pre-submission error (nothing reached the issuer) is retry-eligible; an
      // unclassified genuine decline is treated as soft.
      return outcome === 'error'
        ? { next: 'continue', reason: 'adapter/page error before submission, nothing reached the issuer', declineClass }
        : { next: 'continue', reason: 'unclassified decline — treated as soft', declineClass };
  }
}
