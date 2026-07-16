const form = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const button = document.querySelector('#loginButton');
const spinner = document.querySelector('#loginSpinner');
const label = document.querySelector('#loginLabel');
const error = document.querySelector('#loginError');

function setBusy(busy) {
  button.disabled = busy;
  password.disabled = busy;
  spinner.hidden = !busy;
  label.textContent = busy ? 'Signing in…' : 'Open dashboard';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  setBusy(true);

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || 'Could not sign in');
    }

    window.location.assign('/');
  } catch (caught) {
    error.textContent = caught?.message || String(caught);
    error.hidden = false;
    password.select();
  } finally {
    setBusy(false);
  }
});
