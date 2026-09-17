import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDecline, decide, type Outcome } from './policy.js';

const d = (outcome: Outcome, declineCode?: string, message?: string, attemptsSoFar = 0, maxAttempts = 3) =>
  decide(outcome, { declineCode, message, attemptsSoFar, maxAttempts });

// ---- The 2026-09-07 review's table: generic words must NOT defeat specific codes ----
test('stolen_card + "Your card was declined." → hard_stop (not continue)', () => {
  assert.equal(classifyDecline('stolen_card', 'Your card was declined.'), 'fraud_hard_stop');
  assert.equal(d('declined', 'stolen_card', 'Your card was declined.').next, 'hard_stop');
});

test('expired_card + "Your card was declined." → stop (not continue)', () => {
  assert.equal(classifyDecline('expired_card', 'Your card was declined.'), 'expired_card');
  assert.equal(d('declined', 'expired_card', 'Your card was declined.').next, 'stop');
});

test('fraud + "Payment refused" → hard_stop (not continue)', () => {
  assert.equal(classifyDecline('fraud', 'Payment refused'), 'fraud_hard_stop');
  assert.equal(d('declined', 'fraud', 'Payment refused').next, 'hard_stop');
});

test('do_not_try_again → stop, and NOT classified as processor_error', () => {
  assert.equal(classifyDecline('do_not_try_again', ''), 'do_not_retry');
  assert.notEqual(classifyDecline('do_not_try_again', ''), 'processor_error');
  assert.equal(d('declined', 'do_not_try_again').next, 'stop');
});

// ---- New safety states ----
test('unknown outcome → hard_stop regardless of code', () => {
  assert.equal(d('unknown').next, 'hard_stop');
});

test('Soap deposit_restricted → risk_blocked → hard_stop across the waterfall', () => {
  assert.equal(classifyDecline('deposit_restricted', 'Deposit restricted'), 'risk_blocked');
  assert.equal(d('declined', 'deposit_restricted', 'Deposit restricted').next, 'hard_stop');
});

test('additional verification (Soap) → risk_blocked → hard_stop', () => {
  assert.equal(d('declined', undefined, 'Additional verification needed').next, 'hard_stop');
});

// ---- Soft, routable declines still continue ----
test('insufficient_funds → continue (network-advice retry)', () => {
  assert.equal(classifyDecline('insufficient_funds', 'Not enough balance'), 'insufficient_funds');
  assert.equal(d('declined', 'insufficient_funds').next, 'continue');
});

test('issuer_unavailable → continue', () => {
  assert.equal(d('declined', 'issuer_unavailable').next, 'continue');
});

test('"try again later" message (no code) → processor_error → continue', () => {
  assert.equal(classifyDecline(undefined, 'Please try again later'), 'processor_error');
  assert.equal(d('declined', undefined, 'Please try again later').next, 'continue');
});

// ---- Guards ----
test('attempt cap stops the cascade even for a soft decline', () => {
  assert.equal(d('declined', 'insufficient_funds', undefined, 3, 3).next, 'stop');
});

test('3DS / authentication_required → stop (handoff), not continue', () => {
  assert.equal(classifyDecline('authentication_required', ''), 'authentication_required');
  assert.equal(d('declined', 'authentication_required').next, 'stop');
});

test('pre-submission error → continue (nothing reached the issuer)', () => {
  assert.equal(d('error').next, 'continue');
});
