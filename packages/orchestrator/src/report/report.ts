import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RunResult } from '../cascade/run.js';

function money(cents: number, currency = 'USD'): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export function renderMarkdown(run: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Agentic Gateway — run \`${run.runId}\``);
  lines.push('');
  lines.push('_One customer-authorized purchase across approved API and browser payment routes, with explicit retry and stop rules._');
  lines.push('');
  lines.push(`- Purchase: \`${run.purchaseId}\` — one order (${money(run.amountCents, run.currency)}) bound across every tier`);
  lines.push(`- Card: ${run.card.brand ?? '?'} •••• ${run.card.last4} (BT token \`${run.tokenId}\`)`);
  lines.push(`- Tiers: ${run.tiers.join(' → ')}${run.simulateDecline.length ? ` (simulated declines: ${run.simulateDecline.join(', ')})` : ''}`);
  lines.push(`- Attempt cap per PAN: ${run.maxAttempts}`);
  lines.push(`- Result: **${run.winner ? `authorised (not captured) at ${run.winner}` : 'no gateway accepted the card'}** — ${run.stopReason}`);
  lines.push(`- Started ${run.startedAt}, finished ${run.finishedAt}`);
  lines.push('');
  lines.push('| # | Tier | Outcome | Decline | Decision | Time | Agent session |');
  lines.push('|---|---|---|---|---|---|---|');
  run.attempts.forEach((a, i) => {
    const session = a.provider === 'api' ? 'API · BT Proxy' : a.replayUrl ? `[replay](${a.replayUrl})` : a.provider;
    const outcome =
      a.verdict.outcome === 'succeeded'
        ? `succeeded (${a.verdict.captureState ?? 'authorized'})`
        : a.verdict.outcome === 'unknown'
          ? 'unknown ⚠'
          : a.verdict.outcome;
    const decline = `${a.verdict.declineCode ?? ''}${a.verdict.simulated ? ' _(simulated)_' : ''}`;
    lines.push(
      `| ${i + 1} | ${a.label} | ${outcome}${a.verdict.providerRef ? ` \`${a.verdict.providerRef}\`` : ''} | ${decline} | ${a.decision.next}: ${a.decision.reason} | ${(a.elapsedMs / 1000).toFixed(1)}s | ${session} |`,
    );
  });
  lines.push('');
  for (const a of run.attempts) {
    lines.push(`## ${a.label}`);
    lines.push('');
    if (a.provider === 'api') lines.push('- Authorization: server-to-server via Basis Theory Proxy (Liquid) — the PAN was never revealed in-process.');
    if (a.url) lines.push(`- URL: ${a.url}`);
    if (a.verdict.providerRef) lines.push(`- Provider reference: \`${a.verdict.providerRef}\``);
    if (a.verdict.message) lines.push(`- Provider message: ${a.verdict.message}`);
    if (a.verdict.pageSays) lines.push(`- Page said: ${a.verdict.pageSays}`);
    if (a.error) lines.push(`- Error: \`${a.error.split('\n')[0]}\``);
    if (a.screenshots.length) lines.push(`- Screenshots: ${a.screenshots.map((s) => `\`${basename(s)}\``).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeReport(run: RunResult): string {
  const md = renderMarkdown(run);
  const path = join(run.outDir, 'report.md');
  writeFileSync(path, md);
  return path;
}

export function resultLine(run: RunResult): string {
  return `RESULT: ${JSON.stringify({
    runId: run.runId,
    winner: run.winner ?? null,
    attempts: run.attempts.map((a) => ({ tier: a.tier, outcome: a.verdict.outcome, declineCode: a.verdict.declineCode ?? null, replay: a.replayUrl ?? null })),
    stopReason: run.stopReason,
    report: join(run.outDir, 'report.md'),
  })}`;
}
