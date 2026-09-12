// Called by QStash when a scheduled reminder is due — not by Telegram or
// the user directly. Protected by a shared secret in the query string so
// random requests can't trigger fake reminders to someone's chat.
export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';

  if (req.query.secret !== REMINDER_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const { chatId, message } = req.body || {};
  if (!chatId || !message) {
    return res.status(400).json({ error: 'Missing chatId or message' });
  }

  // Critical: always return 200, even on failure. If Telegram's API has a
  // transient hiccup and we let an exception escape (or return a non-2xx
  // status), QStash interprets that as "delivery failed" and retries per
  // its default backoff (12s, then 2m28s, then 30m8s) — which is exactly
  // what caused the same reminder to fire multiple times earlier. A single
  // failed send should just be a missed reminder, not a retry storm.
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `Reminder: ${message}` })
    });
    return res.status(200).json({ delivered: true });
  } catch (e) {
    return res.status(200).json({ delivered: false, error: e.message });
  }
}
