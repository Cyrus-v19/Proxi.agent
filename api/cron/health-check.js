import { kv } from '@vercel/kv';
import { checkHealth, summarizeProviders } from '../../lib/health.js';
import { logError, errText, getRecentErrors, describeEntries } from '../../lib/errorlog.js';
import { cronAuthorized } from '../../lib/auth.js';

// Triggered daily by Vercel Cron and hourly by a QStash schedule (see
// lib/monitor.js, switched on with /monitor on). Probes every link in the provider chain
// (Groq, NVIDIA, Gemini — each with a real tiny completion on the model
// agent.js actually uses) plus the Telegram bot token. Stays silent when
// everything's fine; only messages the user when something needs a human,
// or when no provider can answer at all. Rate-limited providers are
// reported in the result but are not an alert — that's normal on free tiers.
//
// Every non-ok result is also written to the error log, and the full result
// is kept at health:last so "/errors" and her get_error_log tool can show it.
export default async function handler(req, res) {
  // Only Vercel Cron may trigger this — it spends real tokens on three
  // providers per run. See lib/auth.js (open until CRON_SECRET is set).
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.DAILY_CHAT_ID;

  // Redis holds her memory, notes, reminders and the error log itself, and a
  // dead Redis fails silently everywhere else — so it is checked here, FIRST.
  // If it is down or hung, nothing below touches it again (a hung call would
  // otherwise stall this run and the alert with it); the check still probes
  // the providers and still messages you.
  const redis = await checkRedis();
  const redisUp = redis.status === 'ok';

  // This URL is public, and each run spends a few tokens on three providers.
  // A repeat hit within a minute gets the previous result instead of
  // re-probing, so it can't be used to burn the free-tier quota.
  if (redisUp) {
    try {
      const raw = await kv.get('health:last');
      const last = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (last?.t && Date.now() - Date.parse(last.t) < 60000) {
        return res.status(200).json({ ...last, cached: true });
      }
    } catch (e) { /* no cache available — just run the check */ }
  }

  const result = await checkHealth();

  result.redis = redis;
  if (!redisUp) {
    result.issues = [...result.issues, `Redis (memory, notes, reminders) is down: ${redis.detail}`];
    result.healthy = false;
  }

  if (redisUp) {
    try { await kv.set('health:last', JSON.stringify(result)); } catch (e) { /* best-effort */ }

    for (const r of [...Object.values(result.providers), result.telegram]) {
      if (r.status === 'ok' || r.status === 'unconfigured') continue;
      await logError(`health:${r.label.toLowerCase()}`, `${r.label} ${r.status}: ${r.detail}`, '', r.status === 'down' ? 'error' : 'warn');
    }
    if (!result.healthy) {
      const noProvider = result.issues.find(i => i.startsWith('No AI provider'));
      if (noProvider) await logError('health', noProvider);
    }
  }

  // Because this now runs every hour, it must not message every hour. It
  // speaks up only when: a problem appears or changes, a problem is still
  // there 6 hours later (one reminder), it recovers, or new real errors
  // (not rate limits) were logged since the last time it told you.
  const alerted = CHAT_ID ? await notifyOwner(result, TOKEN, CHAT_ID, redisUp) : false;

  return res.status(200).json({ healthy: result.healthy, issues: result.issues, providers: result.providers, telegram: result.telegram, t: result.t, alerted });
}

const ALERT_KEY = 'health:alert';     // { t, key } — the problem last reported
const ERRSEEN_KEY = 'health:errseen'; // ISO time of the newest error already reported
const REMIND_AFTER_MS = 6 * 3600 * 1000;
const FIRST_RUN_WINDOW_MS = 65 * 60 * 1000; // never dig further back than the last hour

// Stable identity of the current problem set ('' = healthy). Built from
// statuses, not message text, so wording or latency changes don't look new.
function problemKey(result) {
  const down = [...Object.values(result.providers), result.telegram, result.redis].filter(r => r && r.status === 'down').map(r => r.label);
  if (!Object.values(result.providers).some(r => r.status === 'ok')) down.push('no-provider');
  return down.sort().join(',');
}

// A real write + read round trip, with a short deadline so a hung Redis
// can't hold this run open.
async function checkRedis() {
  let timer;
  const probe = (async () => {
    await kv.set('health:ping', String(Date.now()), { ex: 300 });
    await kv.get('health:ping');
  })();
  probe.catch(() => {}); // if the deadline wins first, don't leave an unhandled rejection behind
  try {
    await Promise.race([probe, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no answer within 4s')), 4000); })]);
    return { label: 'Redis', status: 'ok', detail: '' };
  } catch (e) {
    return { label: 'Redis', status: 'down', detail: errText(e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(key) {
  try {
    const raw = await kv.get(key);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return null; }
}

async function send(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (r.ok) return true;
    await logError('health', `Telegram rejected the self-check alert (HTTP ${r.status})`);
  } catch (e) {
    await logError('health', 'Could not send the self-check alert to Telegram', e.message);
  }
  return false;
}

// Returns true if a message was sent. State is only recorded after a
// successful send, so a failed delivery is retried on the next run.
async function notifyOwner(result, token, chatId, redisUp) {
  const key = problemKey(result);
  const state = redisUp ? await readJson(ALERT_KEY) : null;
  const parts = [];
  let nextState; // undefined = leave as is, null = clear

  if (key) {
    const sameProblem = state && state.key === key;
    const due = !sameProblem || Date.now() - Date.parse(state.t) >= REMIND_AFTER_MS;
    if (due) {
      parts.push(`${sameProblem ? 'Still not fixed' : 'Self-check found a problem'}:\n\n${result.issues.join('\n')}\n\nStatus: ${summarizeProviders(result)}.`);
      nextState = { t: new Date().toISOString(), key };
    }
  } else if (state) {
    parts.push(`Back to normal: ${summarizeProviders(result)}.`);
    nextState = null;
  }

  // Real errors (level "error") logged since the last report. The health
  // probes' own entries are excluded — the section above already covers them.
  let newErrors = [];
  if (redisUp) try {
    const seen = Date.parse(await kv.get(ERRSEEN_KEY)) || 0;
    const since = Math.max(seen, Date.now() - FIRST_RUN_WINDOW_MS);
    newErrors = (await getRecentErrors(2)).filter(e => e.level === 'error' && !e.source.startsWith('health') && Date.parse(e.t) > since);
  } catch (e) { /* log unreadable — skip this section */ }
  if (newErrors.length) {
    parts.push(`${newErrors.length} new error${newErrors.length > 1 ? 's' : ''} since my last report:\n${describeEntries(newErrors).join('\n')}\nSend /error for the full picture.`);
  }

  if (!parts.length) return false;
  if (!(await send(token, chatId, parts.join('\n\n')))) return false;

  if (redisUp) try {
    if (nextState) await kv.set(ALERT_KEY, JSON.stringify(nextState));
    else if (nextState === null) await kv.del(ALERT_KEY);
    if (newErrors.length) await kv.set(ERRSEEN_KEY, new Date(Math.max(...newErrors.map(e => Date.parse(e.t)))).toISOString());
  } catch (e) { /* worst case: the same alert repeats next hour */ }
  return true;
}
