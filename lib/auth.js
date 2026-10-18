import { createHash, timingSafeEqual } from 'node:crypto';

// Request authentication for the public endpoints that anyone could otherwise
// POST to or open in a browser.
//
// Both checks are deliberately OPEN until their env var is set, so deploying
// this changes nothing by itself — protection switches on, per endpoint, the
// moment the variable exists in Vercel (and the deployment is redone).
//
// Rejected requests are deliberately NOT written to the error log: an
// attacker could otherwise fill the 200-entry log with junk and push the real
// entries out of it.

// Compares two strings without leaking, through timing, how much of the
// guess was right. Hashing first gives both sides the same length, which
// timingSafeEqual requires (and keeps the secret's length out of it too).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" on every scheduled
// call once a CRON_SECRET env var exists on the project.
export function cronAuthorized(req, env = process.env) {
  // Trimmed because a space or newline pasted along with the value in the
  // Vercel dashboard is invisible there but would reject every real cron call.
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return true;
  return safeEqual(String(req.headers?.authorization || ''), `Bearer ${secret}`);
}

// Telegram sends the secret registered through setWebhook's secret_token in
// the X-Telegram-Bot-Api-Secret-Token header on every webhook call. Without
// this check, anyone who finds the URL can post a forged update "from" any
// chat ID.
export function telegramAuthorized(req, env = process.env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim(); // trimmed for the same reason as CRON_SECRET above
  if (!secret) return true;
  return safeEqual(String(req.headers?.['x-telegram-bot-api-secret-token'] || ''), secret);
}
