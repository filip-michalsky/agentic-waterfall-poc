/**
 * Pull Browserbase MP4 session recordings for a run's UI tiers.
 *
 *   node --env-file=../../.env --import tsx/esm src/media/fetch-recordings.ts --run <runId>
 *
 * Reads out/<runId>/attempts.json, finds attempts recorded on Browserbase
 * (provider === 'browserbase', sessionId parsed from replayUrl), asks Browserbase
 * to prepare the MP4 download, polls until ready, and saves each page to
 * out/<runId>/video/<tier>-<pageId>.mp4. Recording is on by default; downloads
 * are available only after the session ends (our runs close it). Signed URLs are
 * treated as secrets (never logged).
 */
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BB = 'https://api.browserbase.com';
const KEY = process.env.BROWSERBASE_API_KEY;
if (!KEY) throw new Error('BROWSERBASE_API_KEY missing');

const here = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(here, '..', '..', 'out');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const runId = arg('run');
if (!runId) throw new Error('usage: fetch-recordings --run <runId>');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bb = (path: string, init: RequestInit = {}) =>
  fetch(`${BB}${path}`, { ...init, headers: { 'x-bb-api-key': KEY!, 'content-type': 'application/json', ...(init.headers ?? {}) } });

interface Attempt { tier: string; provider: string; replayUrl?: string }
interface DownloadPage { pageId: string; status: string; downloadUrl?: string }

const sessionIdFrom = (replayUrl?: string) => (replayUrl?.match(/sessions\/([\w-]+)/)?.[1]);

async function pull(runId: string) {
  const outDir = join(OUT_ROOT, runId);
  const run = JSON.parse(readFileSync(join(outDir, 'attempts.json'), 'utf8')) as { attempts: Attempt[] };
  const videoDir = join(outDir, 'video');
  mkdirSync(videoDir, { recursive: true });

  const sessions = run.attempts
    .filter((a) => a.provider === 'browserbase')
    .map((a) => ({ tier: a.tier, sessionId: sessionIdFrom(a.replayUrl) }))
    .filter((s): s is { tier: string; sessionId: string } => !!s.sessionId);

  if (!sessions.length) {
    console.log(`no Browserbase sessions in ${runId} (was STAGEHAND_ENV=BROWSERBASE?)`);
    return;
  }

  for (const { tier, sessionId } of sessions) {
    console.log(`[${tier}] session ${sessionId}: requesting MP4 download…`);
    const post = await bb(`/v1/sessions/${sessionId}/recording/downloads`, { method: 'POST' });
    if (post.status !== 202 && !post.ok) {
      console.warn(`[${tier}] download request failed: ${post.status} ${(await post.text()).slice(0, 160)}`);
      continue;
    }
    // Poll until the page(s) are COMPLETED.
    let pages: DownloadPage[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const res = await bb(`/v1/sessions/${sessionId}/recording/downloads`);
      const body = (await res.json().catch(() => ({}))) as { downloads?: DownloadPage[] };
      pages = body.downloads ?? [];
      if (pages.length && pages.every((p) => p.status === 'COMPLETED')) break;
      await sleep(3000);
    }
    const ready = pages.filter((p) => p.status === 'COMPLETED' && p.downloadUrl);
    if (!ready.length) {
      console.warn(`[${tier}] no COMPLETED pages after 90s (status: ${pages.map((p) => p.status).join(',') || 'none'})`);
      continue;
    }
    let i = 0;
    for (const p of ready) {
      const name = ready.length > 1 ? `${tier}-${String(++i).padStart(2, '0')}.mp4` : `${tier}.mp4`;
      const dest = join(videoDir, name);
      const dl = await fetch(p.downloadUrl!); // signed URL — do not log
      if (!dl.ok || !dl.body) {
        console.warn(`[${tier}] download of ${p.pageId} failed: ${dl.status}`);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(dest);
        Readable.fromWeb(dl.body as Parameters<typeof Readable.fromWeb>[0]).pipe(ws).on('finish', () => resolve()).on('error', reject);
      });
      console.log(`[${tier}] saved ${name}`);
    }
  }
  console.log(`\ndone → ${videoDir}`);
}

pull(runId).catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
