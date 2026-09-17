(() => {
  const params = new URLSearchParams(location.search), key = params.get('key');
  const status = document.getElementById('status'), pay = document.getElementById('pay');
  document.getElementById('purchase').textContent = (params.get('purchase') || '').slice(0, 8);
  if (!key?.startsWith('pk_test_')) { status.textContent = 'Open the live classroom and start a sandbox run.'; return; }
  const stripe = Stripe(key), elements = stripe.elements();
  const style = { base: { fontSize: '14px', color: '#172c38', fontFamily: 'system-ui, sans-serif' } };
  const number = elements.create('cardNumber', { style, showIcon: true });
  const expiry = elements.create('cardExpiry', { style });
  const cvc = elements.create('cardCvc', { style });
  let ready = 0, secret;
  for (const [field, target] of [[number, '#card-number'], [expiry, '#card-expiry'], [cvc, '#card-cvc']]) {
    field.on('ready', () => { if (++ready === 3) { window.demoReady = true; document.documentElement.dataset.demoReady = 'true'; } });
    field.mount(target);
  }
  window.prepareDemo = (value) => { secret = value; pay.disabled = false; status.textContent = 'Test card entered. Ready to request authorization.'; };
  document.getElementById('checkout-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!secret || pay.disabled) return;
    pay.disabled = true; status.textContent = 'Stripe is confirming the test authorization…';
    try {
      const result = await stripe.confirmCardPayment(secret, { payment_method: { card: number, billing_details: { name: document.getElementById('holder').value, address: { postal_code: document.getElementById('postal').value } } } });
      if (result.paymentIntent?.status === 'requires_capture') { status.textContent = '✓ Stripe test authorization confirmed. $19.99 authorized · not captured.'; status.className = 'success'; pay.textContent = '✓ Test authorization complete'; }
      else { status.textContent = 'Stripe needs further confirmation. The runner checks the provider before deciding.'; }
    } catch { status.textContent = 'Confirmation interrupted. The runner must check the provider outcome.'; }
    finally { secret = undefined; cvc.clear(); window.demoFinished = true; document.documentElement.dataset.demoFinished = 'true'; }
  });
})();
