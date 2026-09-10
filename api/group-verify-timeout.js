// Called by QStash 5 minutes after a new member joins a verification-gated
// group. If they're still unverified (the pending record still exists),
// kicks them and cleans up the verification prompt message.
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';

  if (req.query.secret !== REMINDER_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const { chatId, userId, promptMessageId } = req.body || {};
  if (!chatId || !userId) {
    return res.status(400).json({ error: 'Missing chatId or userId' });
  }

  async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  const pendingKey = `group:${chatId}:pending:${userId}`;
  const stillPending = await kv.get(pendingKey);

  if (!stillPending) {
    // They verified in time, or the record already expired — nothing to do.
    return res.status(200).json({ kicked: false, reason: 'already verified or expired' });
  }

  await tg('banChatMember', { chat_id: chatId, user_id: userId });
  await tg('unbanChatMember', { chat_id: chatId, user_id: userId }); // kick, not a permanent ban
  if (promptMessageId) {
    await tg('deleteMessage', { chat_id: chatId, message_id: promptMessageId }).catch(() => {});
  }
  await kv.del(pendingKey);

  return res.status(200).json({ kicked: true });
}
