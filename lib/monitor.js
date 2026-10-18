// The hourly self-check. Vercel's free (Hobby) cron can only run once a day,
// so the hourly run is a QStash schedule instead — QStash is already what
// carries reminders and price alerts, so no new service or key is involved.
//
// The schedule simply calls /api/cron/health-check every hour. That endpoint
// stays silent while everything is fine and only messages the owner when
// something is down, newly breaks, or recovers (see api/cron/health-check.js).
//
// One fixed schedule id means turning it on twice just updates the same
// schedule rather than creating a second one.

import { kv } from '@vercel/kv';

export const SCHEDULE_ID = 'proxi-health-monitor';
export const CRON = '0 * * * *'; // minute 0 of every hour
const API = 'https://qstash.upstash.io/v2/schedules';

const say = (ok, text) => ({ ok, text });

export async function enableMonitor(base, env = process.env, fetchImpl = fetch) {
  const token = env.QSTASH_TOKEN;
  if (!token) return say(false, "I can't set that up: QSTASH_TOKEN is missing in Vercel.");
  const headers = {
    Authorization: `Bearer ${token}`,
    'Upstash-Cron': CRON,
    'Upstash-Schedule-Id': SCHEDULE_ID,
    'Upstash-Method': 'GET',
    // No automatic retries: a retry would probe all providers a second time
    // and could repeat an alert.
    'Upstash-Retries': '0'
  };
  // When CRON_SECRET is set the endpoint rejects calls without it, so
  // QStash has to carry it. (Re-run /monitor on if CRON_SECRET ever changes.)
  const cronSecret = env.CRON_SECRET?.trim();
  if (cronSecret) headers['Upstash-Forward-Authorization'] = `Bearer ${cronSecret}`;
  try {
    const r = await fetchImpl(`${API}/${base}/api/cron/health-check`, { method: 'POST', headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return say(false, `QStash refused to create the schedule: ${data.error || `HTTP ${r.status}`}`);
    return say(true, "Hourly self-check is on. I check Groq, NVIDIA, Gemini and Telegram at the top of every hour, and I'll message you only when something goes down, new errors appear, or it recovers. The first check can take up to a minute to start.");
  } catch (e) {
    return say(false, `Couldn't reach QStash: ${e.message}`);
  }
}

export async function disableMonitor(env = process.env, fetchImpl = fetch) {
  const token = env.QSTASH_TOKEN;
  if (!token) return say(false, "I can't change that: QSTASH_TOKEN is missing in Vercel.");
  try {
    const r = await fetchImpl(`${API}/${SCHEDULE_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return say(true, 'The hourly self-check was already off.');
    if (!r.ok) return say(false, `QStash refused to remove the schedule (HTTP ${r.status}).`);
    return say(true, 'Hourly self-check is off. The once-a-day check still runs.');
  } catch (e) {
    return say(false, `Couldn't reach QStash: ${e.message}`);
  }
}

export async function monitorStatus(env = process.env, fetchImpl = fetch) {
  const token = env.QSTASH_TOKEN;
  if (!token) return say(false, "I can't check that: QSTASH_TOKEN is missing in Vercel.");
  try {
    const r = await fetchImpl(API, { headers: { Authorization: `Bearer ${token}` } });
    const all = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(all)) return say(false, `Couldn't read the schedule list from QStash (HTTP ${r.status}).`);
    const mine = all.find(s => s.scheduleId === SCHEDULE_ID);
    if (!mine) return say(true, 'Hourly self-check is OFF. Send /monitor on to turn it on.');
    if (mine.isPaused) return say(true, 'Hourly self-check exists but is PAUSED in the QStash dashboard. Resume it there.');
    // The schedule existing doesn't prove it works (e.g. CRON_SECRET changed
    // after it was created, so every call is rejected). Every check records
    // its time, so a stale one is the tell.
    let ageMin = null;
    try {
      const raw = await kv.get('health:last');
      const h = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (h?.t) ageMin = Math.max(0, Math.round((Date.now() - Date.parse(h.t)) / 60000));
    } catch (e) { /* no record available */ }
    if (ageMin === null) return say(true, 'Hourly self-check is ON (every hour, on the hour). No check has been recorded yet.');
    const ago = ageMin < 90 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`;
    if (ageMin > 75) return say(true, `Hourly self-check is ON, but the last check was ${ago}. If you only just turned it on, wait for the top of the hour. If not, send /monitor on again (needed after CRON_SECRET changes), then check QStash > Logs.`);
    return say(true, `Hourly self-check is ON (every hour, on the hour). Last check: ${ago}.`);
  } catch (e) {
    return say(false, `Couldn't reach QStash: ${e.message}`);
  }
}
