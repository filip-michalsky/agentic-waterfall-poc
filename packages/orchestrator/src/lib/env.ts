/** Tiny env helpers. `.env` is loaded by `node --env-file`, never by code. */

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

export function requireEnv(name: string, hint?: string): string {
  const v = env(name);
  if (!v) {
    throw new Error(`Missing env ${name}${hint ? ` — ${hint}` : ''}`);
  }
  return v;
}

export function envBool(name: string, fallback = false): boolean {
  const v = env(name);
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
