import { kv } from '@vercel/kv';

// A small rolling log of things that went wrong, so Proxi can answer
// "what's been failing?" from real data instead of guessing.
//
// One global list (newest first) in Redis, capped so it can never grow
// without bound. Single-user bot, so there is no per-chat key; reading it is
// restricted to the owner by the callers (see isOwner).
//
// Writing is best-effort by design: logError never throws, because it runs
// inside failure paths — a broken log must never turn one problem into two.

const KEY = 'errorlog';
const HEALTH_KEY = 'health:last';
const MAX_ENTRIES = 200;
const MAX_FIELD = 300;

// Error messages from fetch/providers can embed URLs and headers. Scrub
// anything secret-shaped before it is stored, since the log is later pasted
// into Telegram chats.
const SECRET_ENV_NAMES = [
  'TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY',
  'SERPER_API_KEY', 'QSTASH_TOKEN', 'REMINDER_SECRET'
];

export function redact(text) {
  let s = String(text ?? '');
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (v && v.length >= 8) s = s.split(v).join('[redacted]');
  }
  // A webhook URL works like a password, so scrub each configured one too.
  for (const part of String(process.env.WEBHOOKS || '').split(/[\s,]+/)) {
    const url = part.includes('=') ? part.slice(part.indexOf('=') + 1) : '';
    if (url.length >= 12) s = s.split(url).join('[redacted]');
  }
  return s
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:key|secret|token|api_key)=)[^&\s]+/gi, '$1[redacted]');
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Turns whatever was thrown/returned into readable text.
export function errText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (x.message) return String(x.message);
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}

// The owner is whoever DAILY_CHAT_ID points at. Fails closed: if it isn't
// set, nobody can read or clear the log (the bot has no allow-list, so
// anyone who finds it can chat with it).
export function isOwner(chatId) {
  const owner = process.env.DAILY_CHAT_ID;
  return !!owner && chatId != null && String(chatId) === String(owner);
}

// level: 'error' (something failed for real) or 'warn' (expected/recoverable,
// e.g. a rate limit that the fallback chain absorbed).
export async function logError(source, message, detail = '', level = 'error') {
  try {
    const entry = {
      t: new Date().toISOString(),
      level: level === 'warn' ? 'warn' : 'error',
      source: clip(source, 48),
      message: clip(redact(errText(message)), MAX_FIELD),
      detail: clip(redact(errText(detail)), MAX_FIELD)
    };
    await kv.lpush(KEY, JSON.stringify(entry));
    await kv.ltrim(KEY, 0, MAX_ENTRIES - 1);
  } catch (e) {
    /* never let logging break the thing being logged */
  }
}

// The Redis client may hand back parsed objects or raw JSON strings.
function parseEntry(x) {
  try {
    const o = typeof x === 'string' ? JSON.parse(x) : x;
    return o && o.t && o.source ? o : null;
  } catch (e) {
    return null;
  }
}

export async function getRecentErrors(hours = 24) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const cutoff = Date.now() - h * 3600 * 1000;
  const raw = (await kv.lrange(KEY, 0, MAX_ENTRIES - 1)) || [];
  return raw.map(parseEntry).filter(e => e && Date.parse(e.t) >= cutoff);
}

export async function clearErrors() {
  await kv.del(KEY);
}

function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Groups near-identical entries (same source, same message ignoring numbers
// such as wait times and ids) so ten rate-limit hits read as one line.
function groupEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    const norm = e.message.toLowerCase().replace(/[0-9.]+/g, '#').slice(0, 80);
    const k = `${e.source}|${norm}`;
    const g = groups.get(k) || { source: e.source, message: e.message, level: e.level, count: 0, last: e.t };
    g.count += 1;
    if (e.level === 'error') g.level = 'error';
    if (Date.parse(e.t) > Date.parse(g.last)) { g.last = e.t; g.message = e.message; }
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || Date.parse(b.last) - Date.parse(a.last));
}

// Short numbered lines for an alert message: the most frequent distinct
// problems among the given entries, with counts.
export function describeEntries(entries, max = 5, now = Date.now()) {
  return groupEntries(entries).slice(0, max).map((g, i) =>
    `${i + 1}. ${g.source}: ${g.message}${g.count > 1 ? ` (x${g.count}, last ${ago(g.last, now)})` : ` (${ago(g.last, now)})`}`);
}

async function healthLine(now) {
  try {
    const raw = await kv.get(HEALTH_KEY);
    const h = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!h || !h.t) return 'Last health check: none recorded yet.';
    const parts = Object.values(h.providers || {}).map(p => `${p.label} ${p.status}`);
    if (h.telegram) parts.push(`Telegram ${h.telegram.status}`);
    return `Last health check (${ago(h.t, now)}): ${parts.join(', ')}.`;
  } catch (e) {
    return 'Last health check: unavailable.';
  }
}

// One report used by both the get_error_log tool and the /errors command.
export async function buildErrorReport({ hours = 24 } = {}) {
  const now = Date.now();
  const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const entries = await getRecentErrors(h);
  const health = await healthLine(now);
  const window = h === 24 ? 'the last 24 hours' : `the last ${h} hours`;

  if (entries.length === 0) {
    return `No errors logged in ${window}.\n${health}`;
  }

  const errors = entries.filter(e => e.level === 'error').length;
  const warns = entries.length - errors;
  const bySource = {};
  for (const e of entries) bySource[e.source] = (bySource[e.source] || 0) + 1;
  const sourceLine = Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');

  const groups = groupEntries(entries).slice(0, 8);
  const lines = [
    `${entries.length} logged in ${window}: ${errors} errors, ${warns} warnings (warnings are things like rate limits the fallback chain absorbed).`,
    `By source: ${sourceLine}.`,
    'Most frequent:'
  ];
  groups.forEach((g, i) => {
    lines.push(`${i + 1}. [${g.level}] ${g.source}: ${g.message}${g.count > 1 ? ` (x${g.count}, last ${ago(g.last, now)})` : ` (${ago(g.last, now)})`}`);
  });
  lines.push(health);
  return lines.join('\n');
}
