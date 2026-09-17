/**
 * One "spawned agent" = one browser session + one Stagehand instance.
 *
 * STAGEHAND_ENV=BROWSERBASE → browserbase.launch (replay URL logged)
 * STAGEHAND_ENV=LOCAL       → localBrowser.launch (HEADFUL=1 to watch)
 *
 * Close order matters in v4: stagehand first, then the browser.
 */
import { Stagehand, browserbase, localBrowser, type Page, type StagehandBrowser } from '@browserbasehq/stagehand';
import { env, envBool, requireEnv } from '../lib/env.js';
import { logger, redact } from '../lib/log.js';

const log = logger('session');

export interface AgentSession {
  sh: Stagehand;
  browser: StagehandBrowser;
  page: Page;
  provider: 'local' | 'browserbase';
  sessionId?: string;
  replayUrl?: string;
  close(): Promise<void>;
}

export interface SessionOptions {
  /** Force a provider regardless of STAGEHAND_ENV. */
  provider?: 'local' | 'browserbase';
  /** Skip Stagehand model wiring (pure CDP sessions, e.g. the filler smoke). */
  withoutModel?: boolean;
  /** Browserbase session timeout (seconds). */
  timeoutSeconds?: number;
  /** Set only for a presenter-opted-in sandbox broadcast. */
  broadcastId?: string;
}

function modelConfig(): { modelName: string; apiKey?: string } {
  const modelName = env('STAGEHAND_MODEL', 'openai/gpt-4.1-mini')!;
  const provider = modelName.split('/')[0];
  const keyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'google' ? 'GOOGLE_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = requireEnv(keyVar, `needed for STAGEHAND_MODEL=${modelName}`);
  redact(apiKey);
  return { modelName, apiKey };
}

export async function openSession(opts: SessionOptions = {}): Promise<AgentSession> {
  const provider = opts.provider ?? (env('STAGEHAND_ENV', 'LOCAL')!.toUpperCase() === 'BROWSERBASE' ? 'browserbase' : 'local');

  let browser: StagehandBrowser;
  if (provider === 'browserbase') {
    const apiKey = requireEnv('BROWSERBASE_API_KEY');
    const projectId = requireEnv('BROWSERBASE_PROJECT_ID');
    redact(apiKey);
    browser = await browserbase.launch({
      apiKey,
      projectId,
      timeout: opts.timeoutSeconds ?? 600,
      ...(opts.broadcastId ? { userMetadata: { app: 'soap-waterfall-live', broadcastId: opts.broadcastId } } : {}),
      // Browserbase records sessions by default (that is what gives the replay URL
      // the report links to). Recording captures the filled card fields — fine for
      // TEST PANs, but production would set BROWSERBASE_RECORD=false and rely on a
      // BT-side filler so the PAN is never in the frame. See README security notes.
      browserSettings: {
        ...(envBool('BROWSERBASE_RECORD', true) ? {} : { recordSession: false }),
        // A readable viewport for the educational embed; ordinary recordings
        // retain Browserbase's default desktop dimensions.
        ...(opts.broadcastId ? { viewport: { width: 1000, height: 800 } } : {}),
      },
    } as Parameters<typeof browserbase.launch>[0]);
  } else {
    browser = await localBrowser.launch({
      headless: !envBool('HEADFUL', false),
      ignoreHTTPSErrors: true,
      args: ['--ignore-certificate-errors'],
    } as Parameters<typeof localBrowser.launch>[0]);
  }

  const sessionId = browser.sessionId;
  const replayUrl = sessionId ? `https://www.browserbase.com/sessions/${sessionId}` : undefined;
  if (replayUrl) log.info(`REPLAY: ${replayUrl}`);
  else log.info(`local chromium (${envBool('HEADFUL') ? 'headful' : 'headless'})`);

  const sh = await Stagehand.create({
    browser,
    ...(opts.withoutModel ? {} : { model: modelConfig() }),
    // Stagehand's own logs never see card values (the filler types via page.type,
    // which is not logged at default level), but keep it quiet regardless.
    logging: { level: 'warn' },
  } as Parameters<typeof Stagehand.create>[0]);

  const page = (await browser.context.activePage()) ?? (await browser.context.newPage());

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sh.close().catch((e) => log.warn(`stagehand.close: ${String(e).slice(0, 100)}`));
    await browser.close().catch((e) => log.warn(`browser.close: ${String(e).slice(0, 100)}`));
  };

  return { sh, browser, page, provider, sessionId, replayUrl, close };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Screenshot helper that never throws (diagnostics only). */
export async function shot(page: Page, path: string): Promise<string | undefined> {
  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch (e) {
    log.warn(`screenshot failed: ${String(e).slice(0, 100)}`);
    return undefined;
  }
}
