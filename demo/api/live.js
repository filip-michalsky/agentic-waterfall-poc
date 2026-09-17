import { createHandler, safeLiveUrl } from '../lib/live-state.js';
import { read, write } from '../lib/store.js';
async function browserbase(path) {
  const key = process.env.BROWSERBASE_API_KEY;
  if (!key) throw new Error('Browserbase is not configured');
  const response = await fetch(`https://api.browserbase.com/v1/sessions/${path}`, {
    headers: { 'x-bb-api-key': key }, signal: AbortSignal.timeout(6000), cache: 'no-store',
  });
  if (!response.ok) throw new Error('Browserbase request failed');
  return response.json();
}
async function liveView(sessionId, broadcastId) {
  const session = await browserbase(sessionId);
  if (session.projectId !== process.env.BROWSERBASE_PROJECT_ID || session.userMetadata?.broadcastId !== broadcastId || session.userMetadata?.app !== 'soap-waterfall-live') return { status: 'unavailable' };
  if (session.status !== 'RUNNING') return { status: 'ended' };
  const debug = await browserbase(`${sessionId}/debug`);
  const url = safeLiveUrl(debug.debuggerFullscreenUrl);
  return url ? { status: 'running', sessionId, url } : { status: 'unavailable' };
}

export default createHandler({ read, write, liveView, secret: () => process.env.LIVE_BROADCAST_SECRET });
