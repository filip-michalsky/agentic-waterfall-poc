/**
 * Logger with secret redaction.
 *
 * Two registries:
 *   - `secrets`   long-lived values (API keys) registered via `redact()`.
 *   - `ephemeral` card values (PAN, CVC) registered via `redactEphemeral()` and
 *                 wiped by `clearEphemeral()` after each attempt, so revealed card
 *                 data does not linger in process memory past the attempt that used
 *                 it. (A module boundary is not memory isolation — see README
 *                 "Security boundary & gaps".)
 *
 * Anything in either set is replaced by `***` in every console/file line. CVCs are
 * three digits, so the length guard admits digit-only values down to 3 chars
 * (the earlier `< 4` guard silently skipped CVCs).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const secrets = new Set<string>();
const ephemeral = new Set<string>();
let logFile: string | undefined;

function register(set: Set<string>, value: string | undefined | null): void {
  const digitOnly = typeof value === 'string' && /^\d+$/.test(value);
  const min = digitOnly ? 3 : 4; // 3-digit CVC must be caught; keep 4 for noisy non-digits
  if (!value || value.length < min) return;
  set.add(value);
  if (digitOnly) {
    // catch the same digits when spaced or dashed (as hosted fields echo them)
    set.add(value.replace(/(\d{4})(?=\d)/g, '$1 ').trim());
    set.add(value.replace(/(\d{4})(?=\d)/g, '$1-').trim());
  }
}

/** Register a long-lived secret (API key). Never cleared. */
export function redact(value: string | undefined | null): void {
  register(secrets, value);
}

/** Register a card value (PAN/CVC). Cleared by clearEphemeral() after the attempt. */
export function redactEphemeral(value: string | undefined | null): void {
  register(ephemeral, value);
}

/** Wipe revealed card values from memory. Call in the per-attempt `finally`. */
export function clearEphemeral(): void {
  ephemeral.clear();
}

export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join('***');
  for (const s of ephemeral) if (s && out.includes(s)) out = out.split(s).join('***');
  return out;
}

export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

function emit(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', scope: string, args: unknown[]): void {
  const text = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  const line = scrub(`${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${text}`);
  if (level === 'DEBUG' && process.env.AWF_DEBUG !== '1') {
    // still persisted, just not printed
  } else if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      /* logging must never break a run */
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return `[unserialisable: ${(e as Error).message}]`;
  }
}

export function logger(scope: string) {
  return {
    info: (...a: unknown[]) => emit('INFO', scope, a),
    warn: (...a: unknown[]) => emit('WARN', scope, a),
    error: (...a: unknown[]) => emit('ERROR', scope, a),
    debug: (...a: unknown[]) => emit('DEBUG', scope, a),
  };
}
