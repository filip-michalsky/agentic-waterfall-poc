/**
 * waterfall CLI
 *
 *   vault   --pan 4242424242424242 --exp 12/30 --cvc 123        tokenize once (BT test tenant)
 *   run     --token <tok> [--tiers stripe,adyen,checkout-com,whop] [--simulate-decline stripe,adyen]
 *           [--amount 1999] [--max-attempts 3] [--broadcast]
 *           --broadcast shares this sandbox run at LIVE_DEMO_URL/live
 *           dev only: --inline-card 4242424242424242 --exp 12/30 --cvc 123   (bypasses the vault)
 *   report  --run <runId>                                         re-render report.md
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCascade, type RunResult } from './cascade/run.js';
import { logger } from './lib/log.js';
import { resultLine, writeReport } from './report/report.js';
import { parseTiers } from './targets/index.js';
import type { TargetId } from './targets/types.js';
import { BasisTheoryCardSource, tokenize } from './vault/basis-theory.js';
import { InlineTestCardSource } from './vault/inline.js';

const log = logger('cli');
const here = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(here, '..', 'out');

function args(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { cmd, flags };
}

const SHOPPER = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada+awf@example.com', postalCode: '94103' };

function runIdNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const { cmd, flags } = args(process.argv.slice(2));
  const str = (k: string, d?: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : d);

  switch (cmd) {
    case 'vault': {
      const pan = str('pan');
      const exp = str('exp');
      const cvc = str('cvc');
      if (!pan || !exp || !cvc) throw new Error('vault needs --pan --exp MM/YY --cvc');
      const [mm, yy] = exp.split('/').map((x) => Number(x));
      const t = await tokenize({ number: pan, expMonth: mm, expYear: yy, cvc });
      console.log(`RESULT: ${JSON.stringify({ tokenId: t.id, last4: t.card?.last4, brand: t.card?.brand })}`);
      return;
    }

    case 'run': {
      const tokenId = str('token');
      const inline = str('inline-card');
      if (!tokenId && !inline) throw new Error('run needs --token <bt token id> (from `waterfall vault`) or, for dev only, --inline-card <test PAN> --exp MM/YY --cvc 123');
      let source: BasisTheoryCardSource | InlineTestCardSource;
      if (tokenId) source = new BasisTheoryCardSource(tokenId);
      else {
        const [mm, yy] = (str('exp', '12/30') as string).split('/').map((x) => Number(x));
        source = new InlineTestCardSource({ number: inline!, expMonth: mm, expYear: yy, cvc: str('cvc', '123')! });
        log.warn('DEV MODE: card supplied inline, bypassing the Basis Theory vault');
      }
      const runId = str('run-id', runIdNow())!;
      const tiers = parseTiers(str('tiers'));
      const simulateDecline = (str('simulate-decline', '') as string).split(',').map((s) => s.trim()).filter(Boolean) as TargetId[];
      const run = await runCascade({
        runId,
        tokenId: tokenId ?? source.id,
        source,
        tiers,
        simulateDecline,
        amountCents: Number(str('amount', '1999')),
        currency: str('currency', 'usd')!,
        maxAttempts: Number(str('max-attempts', '3')),
        shopper: SHOPPER,
        outRoot: OUT_ROOT,
        // One purchase per run by default; pass the SAME --purchase-id twice to prove
        // the double-charge guard refuses the second run.
        purchaseId: str('purchase-id', runId)!,
        merchant: str('merchant', 'agentic-waterfall-demo')!,
        injectPostSubmitFailure: !!flags['inject-lost-response'],
        simulateDeclineCode: str('simulate-decline-code'),
        broadcast: !!flags['broadcast'],
      });
      const report = writeReport(run);
      log.info(`report: ${report}`);
      console.log(resultLine(run));
      process.exitCode = run.winner ? 0 : 2;
      return;
    }

    case 'report': {
      const runId = str('run');
      if (!runId) throw new Error('report needs --run <runId>');
      const outDir = join(OUT_ROOT, runId);
      const run = JSON.parse(readFileSync(join(outDir, 'attempts.json'), 'utf8')) as RunResult;
      const report = writeReport(run);
      console.log(readFileSync(report, 'utf8'));
      return;
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\s*/, ''));
  }
}

main().catch((e) => {
  log.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
