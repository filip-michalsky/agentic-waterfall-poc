/** Shared HTML shell for the storefront pages. */
export function page(opts: {
  title: string;
  provider: string;
  attemptId: string;
  amountCents: number;
  scripts?: string[];
  body: string;
  script: string;
}): string {
  const scripts = (opts.scripts ?? []).map((s) => `<script src="${s}"></script>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${opts.title}</title>
${scripts}
<style>
  body { font: 15px/1.4 system-ui, sans-serif; margin: 0; padding: 32px; background: #fafafa; color: #222; }
  main { max-width: 440px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 12px; box-shadow: 0 1px 6px rgba(0,0,0,.08); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #777; font-size: 12px; margin-bottom: 16px; }
  label { display: block; margin: 12px 0 0; font-size: 13px; color: #555; }
  input, .hosted { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px; border: 1px solid #cfd4dc; border-radius: 6px; font-size: 16px; background: #fff; min-height: 42px; }
  .row { display: flex; gap: 12px; } .row label { flex: 1; }
  button { margin-top: 20px; width: 100%; padding: 12px; font-size: 16px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; cursor: pointer; }
  #status { margin-top: 16px; padding: 10px 12px; border-radius: 6px; background: #f1f3f5; font-size: 14px; min-height: 20px; }
  #status.succeeded { background: #d3f9d8; color: #14532d; }
  #status.declined, #status.error { background: #ffe3e3; color: #7f1d1d; }
  #status.pending { background: #fff3bf; color: #7c5a00; }
</style>
</head>
<body>
<main>
  <h1>${opts.title}</h1>
  <div class="meta">provider=${opts.provider} · attempt=${opts.attemptId} · amount=$${(opts.amountCents / 100).toFixed(2)}</div>
  ${opts.body}
  <div id="status" data-status="idle">Ready.</div>
</main>
<script>
  const ATTEMPT_ID = ${JSON.stringify(opts.attemptId)};
  const AMOUNT_CENTS = ${opts.amountCents};
  function setStatus(text, cls) {
    const el = document.getElementById('status');
    el.textContent = text; el.className = cls || ''; el.dataset.status = cls || 'info';
  }
</script>
<script>
${opts.script}
</script>
</body>
</html>`;
}
