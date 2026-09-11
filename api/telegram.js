// This is intentionally tiny. Vercel's Hobby plan caps every serverless
// function at 10 seconds — genuinely too short for a request that might
// download a file, call an AI provider across a 3-tier fallback chain, and
// rebuild/send a file back. If that whole chain runs inline here and blows
// past 10s, Telegram sees no response and RE-DELIVERS the same update,
// causing the same message to be processed multiple times (this caused the
// spreadsheet/reminder duplication bugs).
//
// The fix: acknowledge Telegram immediately, and hand the actual work off
// to telegram-worker.js via a QStash message with zero delay. QStash's own
// retries are disabled for this dispatch so it can't introduce a second
// duplication problem of its own.
import worker from './telegram-worker.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
  const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';
  const update = req.body;

  if (QSTASH_TOKEN) {
    try {
      const base = `https://${req.headers.host}`;
      const destination = `${base}/api/telegram-worker?secret=${REMINDER_SECRET}`;
      const dispatchRes = await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${QSTASH_TOKEN}`,
          'Content-Type': 'application/json',
          'Upstash-Retries': '0'
        },
        body: JSON.stringify(update)
      });
      if (dispatchRes.ok) {
        return res.status(200).send('OK');
      }
      // Dispatch itself failed — fall through to inline processing below
      // rather than silently dropping the message.
    } catch (e) {
      // Same — fall through to inline processing.
    }
  }

  // Fallback (QStash not configured, or the dispatch call itself failed):
  // process inline. This reintroduces the original timeout risk, but only
  // as a last resort rather than losing the message entirely.
  return worker(req, res, true);
}
