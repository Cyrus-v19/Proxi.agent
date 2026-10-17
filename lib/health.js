// Real end-to-end probes for every link in the provider chain
// (Groq -> NVIDIA -> Gemini) plus the Telegram bot token.
//
// Each provider gets a tiny actual chat completion against the SAME model
// agent.js uses — not just a "is the key valid" ping — because the failure
// that has bitten before is a model being pulled from an account while the
// key stays fine. Keep the model names below in sync with agent.js.
//
// Statuses:
//   ok            answered normally
//   limited       HTTP 429 — a normal free-tier condition, not a fault
//   degraded      timeout, network error, 5xx, odd response — likely transient
//   down          auth failure / model gone / bad request — needs a human
//   unconfigured  optional provider with no key set (that tier is skipped)

const PROBE_TIMEOUT_MS = 6000; // all probes run in parallel; Vercel Hobby allows ~10s total

export const PROVIDERS = [
  { id: 'groq', label: 'Groq', keyEnv: 'GROQ_API_KEY', required: true,
    url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b' },
  { id: 'nvidia', label: 'NVIDIA', keyEnv: 'NVIDIA_API_KEY', required: false,
    url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
  { id: 'gemini', label: 'Gemini', keyEnv: 'GEMINI_API_KEY', required: false,
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-flash-latest' }
];

function providerError(data) {
  // Gemini's OpenAI-compat layer sometimes wraps errors in an array.
  const e = Array.isArray(data) ? data[0]?.error : data?.error;
  return e?.message ? String(e.message).slice(0, 160) : '';
}

async function timedFetch(fetchImpl, url, options) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { ...options, signal: controller.signal });
    let data = null;
    try { data = await r.json(); } catch (e) { /* non-JSON body */ }
    return { httpStatus: r.status, ok: r.ok, data, ms: Date.now() - started };
  } catch (e) {
    return { network: true, aborted: e?.name === 'AbortError', message: e?.message || 'request failed', ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function classify(res) {
  if (res.network) {
    return res.aborted
      ? { status: 'degraded', detail: `timed out after ${PROBE_TIMEOUT_MS / 1000}s` }
      : { status: 'degraded', detail: `unreachable: ${res.message}` };
  }
  const msg = providerError(res.data);
  if (res.ok) {
    return res.data?.choices
      ? { status: 'ok', detail: '' }
      : { status: 'degraded', detail: 'answered without a completion' };
  }
  if (res.httpStatus === 429) return { status: 'limited', detail: 'rate limited right now' };
  if (res.httpStatus === 401 || res.httpStatus === 403) {
    return { status: 'down', detail: `auth failed (HTTP ${res.httpStatus})${msg ? ': ' + msg : ''}` };
  }
  if (res.httpStatus >= 500) {
    return { status: 'degraded', detail: `server error (HTTP ${res.httpStatus})${msg ? ': ' + msg : ''}` };
  }
  // 400/404/anything else 4xx: typically the model was pulled or renamed.
  return { status: 'down', detail: `HTTP ${res.httpStatus}${msg ? ': ' + msg : ''}` };
}

async function probeProvider(p, env, fetchImpl) {
  const key = env[p.keyEnv];
  if (!key) {
    return p.required
      ? { label: p.label, status: 'down', detail: `${p.keyEnv} is not set`, ms: 0 }
      : { label: p.label, status: 'unconfigured', detail: `${p.keyEnv} not set — that tier is skipped`, ms: 0 };
  }
  const res = await timedFetch(fetchImpl, p.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 })
  });
  return { label: p.label, ...classify(res), ms: res.ms };
}

async function probeTelegram(env, fetchImpl) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { label: 'Telegram', status: 'down', detail: 'TELEGRAM_BOT_TOKEN is not set', ms: 0 };
  const res = await timedFetch(fetchImpl, `https://api.telegram.org/bot${token}/getMe`, {});
  if (res.network) {
    // Don't echo res.message here — fetch errors can include the URL (and token).
    return { label: 'Telegram', status: 'degraded', detail: res.aborted ? 'timed out' : 'unreachable', ms: res.ms };
  }
  return res.data?.ok
    ? { label: 'Telegram', status: 'ok', detail: '', ms: res.ms }
    : { label: 'Telegram', status: 'down', detail: 'bot token invalid or bot unreachable', ms: res.ms };
}

// Returns { t, healthy, providers: {groq, nvidia, gemini}, telegram, issues[] }.
// "issues" are only things worth waking the user for: a provider that is
// down (needs a human), or no provider able to answer at all. A provider
// that is merely rate-limited is normal and is reported, not alerted.
export async function checkHealth(env = process.env, fetchImpl = fetch) {
  const [results, telegram] = await Promise.all([
    Promise.all(PROVIDERS.map(p => probeProvider(p, env, fetchImpl))),
    probeTelegram(env, fetchImpl)
  ]);

  const providers = {};
  PROVIDERS.forEach((p, i) => { providers[p.id] = results[i]; });

  const issues = [];
  for (const p of PROVIDERS) {
    const r = providers[p.id];
    if (r.status === 'down') issues.push(`${r.label}: ${r.detail}`);
  }
  if (telegram.status === 'down') issues.push(`Telegram: ${telegram.detail}`);

  const answering = Object.values(providers).some(r => r.status === 'ok');
  if (!answering) issues.push('No AI provider is answering right now, so I cannot reply to anything until one recovers.');

  return { t: new Date().toISOString(), healthy: issues.length === 0, providers, telegram, issues };
}

export function summarizeProviders(h) {
  const parts = Object.values(h.providers).map(r => `${r.label} ${r.status}${r.status === 'ok' && r.ms ? ` (${r.ms}ms)` : ''}`);
  parts.push(`Telegram ${h.telegram.status}`);
  return parts.join(', ');
}
