/**
 * awf-reveal — Basis Theory reactor (node22 runtime) used by the Agentic Gateway POC.
 *
 * Basis Theory never returns a token's CVC on a plain read; it only releases it
 * through detokenization inside a proxy or a reactor. This reactor is the
 * smallest possible detokenizer: the caller passes card fields as
 * `{{ token: <id> | json: '$.data.<field>' }}` expressions in `args.card`, BT
 * substitutes the plaintext before invoking, and the reactor echoes it back in
 * the response body (never persisted by BT).
 *
 * node22 contract: handler receives `event` ({ req, ... }) and returns
 * `{ res: { statusCode, body } }`.
 *
 * Create (test tenant, management key with reactor:create):
 *   npx -y @basis-theory-labs/cli reactors create -x <mgmt key> -n awf-reveal \
 *     -r bt/reactor.js --package-json bt/package.json \
 *     --image node22 --permissions token:use --no-async --timeout 10 \
 *     --resources standard --warm-concurrency 0 --no-wait
 */
module.exports = async function (event) {
  const req = (event && event.req) || event || {};
  const args = req.args || (req.body && req.body.args) || {};
  const card = args.card || req.card || {};
  return {
    res: {
      statusCode: 200,
      body: { raw: card },
    },
  };
};
