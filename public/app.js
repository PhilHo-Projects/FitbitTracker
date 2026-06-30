// FitbitTracker dashboard — calls the server-side proxy (/api/fitness),
// which forwards to the n8n webhook. Renders defensively: even an unexpected
// shape still shows the raw JSON instead of crashing.

const $ = (sel) => document.querySelector(sel);

const els = {
  btn: $('#syncBtn'),
  spinner: $('#syncSpinner'),
  label: $('#syncLabel'),
  raw: $('#raw'),
  elapsed: $('#elapsed'),
  banner: $('#banner'),
  identity: $('#identity'),
  identityPic: $('#identityPic'),
  identityName: $('#identityName'),
  identityEmail: $('#identityEmail'),
  steps: $('#metricSteps'),
  calories: $('#metricCalories'),
  distance: $('#metricDistance'),
  heart: $('#metricHeart'),
};

const fmt = (n, digits = 0) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: digits })
    : '—';

function setStatus(key, ok, text) {
  const card = document.querySelector(`[data-status="${key}"]`);
  if (!card) return;
  const dot = card.querySelector('.status-dot');
  const label = card.querySelector('.status-text');
  dot.className =
    'status-dot h-2.5 w-2.5 rounded-full ' +
    (ok === true ? 'bg-emerald-400' : ok === false ? 'bg-rose-500' : 'bg-slate-600');
  label.className =
    'status-text text-sm ' +
    (ok === true ? 'text-emerald-300' : ok === false ? 'text-rose-300' : 'text-slate-400');
  label.textContent = text;
}

function showBanner(kind, message) {
  els.banner.classList.remove('hidden', 'border-rose-800', 'bg-rose-950/50', 'text-rose-200',
    'border-amber-800', 'bg-amber-950/40', 'text-amber-200', 'border-emerald-800',
    'bg-emerald-950/40', 'text-emerald-200');
  const styles = {
    error: ['border-rose-800', 'bg-rose-950/50', 'text-rose-200'],
    warn: ['border-amber-800', 'bg-amber-950/40', 'text-amber-200'],
    ok: ['border-emerald-800', 'bg-emerald-950/40', 'text-emerald-200'],
  }[kind] || ['border-slate-800', 'text-slate-200'];
  els.banner.classList.add(...styles);
  els.banner.textContent = message;
}

function setLoading(loading) {
  els.btn.disabled = loading;
  els.spinner.classList.toggle('hidden', !loading);
  els.label.textContent = loading ? 'Syncing…' : 'Sync from Google Fit';
}

function renderPayload(payload) {
  // `payload.data` is whatever n8n returned. Be liberal about the shape.
  const d = payload?.data ?? {};
  const auth = d.auth ?? d.sections?.userinfo ?? {};
  const summary = d.summary ?? {};
  const sections = d.sections ?? {};

  // Identity
  const user = auth.user ?? auth.data ?? {};
  if (user && (user.email || user.name)) {
    els.identity.classList.remove('hidden');
    els.identityName.textContent = user.name || user.given_name || '—';
    els.identityEmail.textContent = user.email || '—';
    if (user.picture) els.identityPic.src = user.picture;
  }

  // Status pills
  const authOk = auth.ok ?? Boolean(user.email);
  setStatus('auth', authOk, authOk ? `Connected${user.email ? ' · ' + user.email : ''}` : (auth.error || 'Auth failed'));

  const ds = sections.dataSources ?? {};
  if ('ok' in ds || 'count' in ds) {
    setStatus('dataSources', ds.ok ?? null, ds.ok ? `${ds.count ?? '?'} data sources` : (ds.error || 'Unavailable'));
  }

  const agg = sections.aggregate ?? {};
  if ('ok' in agg) {
    setStatus('aggregate', agg.ok, agg.ok ? 'Buckets received' : (agg.error || 'Unavailable'));
  }

  // Metric cards
  els.steps.textContent = fmt(summary.totalSteps);
  els.calories.textContent = summary.totalCalories != null ? `${fmt(summary.totalCalories)} kcal` : '—';
  els.distance.textContent =
    summary.totalDistanceMeters != null ? `${fmt(summary.totalDistanceMeters / 1000, 2)} km` : '—';
  els.heart.textContent = summary.avgHeartRateBpm != null ? `${fmt(summary.avgHeartRateBpm)} bpm` : '—';
}

async function sync() {
  setLoading(true);
  els.banner.classList.add('hidden');
  els.raw.textContent = 'Calling n8n…';
  try {
    const res = await fetch('/api/fitness', { method: 'POST' });
    const payload = await res.json();
    els.raw.textContent = JSON.stringify(payload, null, 2);
    els.elapsed.textContent = payload.elapsedMs != null ? `${payload.elapsedMs} ms` : '';

    if (!payload.ok) {
      // Proxy or webhook-level failure.
      const msg = payload.message || 'Request failed';
      const hint = payload.hint ? ` — ${payload.hint}` : '';
      showBanner('error', `${msg}${hint}`);
      setStatus('auth', false, 'No data');
      setStatus('dataSources', null, '—');
      setStatus('aggregate', null, '—');
      return;
    }

    renderPayload(payload);
    showBanner('ok', 'Sync complete. See per-section status above and the raw response below.');
  } catch (err) {
    els.raw.textContent = String(err);
    showBanner('error', `Could not reach the dashboard API: ${err.message || err}`);
  } finally {
    setLoading(false);
  }
}

els.btn.addEventListener('click', sync);
