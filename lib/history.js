import { kv } from '@vercel/kv';

// Matches MAX_HISTORY_MESSAGES in api/telegram-worker.js. If that number
// changes, change it here too — otherwise the two would keep re-trimming
// each other's writes to different lengths.
const MAX_HISTORY_MESSAGES = 12;

// Records something Proxi said on her OWN initiative (daily briefing,
// reminder, price alert) into the chat's conversation history.
//
// Why this exists: those messages are sent straight to Telegram by cron /
// QStash jobs, completely outside the normal request flow, so they never
// entered her memory. When the user replied to one ("is there a photo of
// the five people?"), she had no record of ever saying it and asked
// "which five people?". Writing it into history here means the user's very
// next message already has the context.
//
// Best-effort by design: this runs after the message has already been
// delivered, and must never throw — several callers (reminder-fire,
// price-watch) have to always return 200 or QStash retries and duplicates
// the message.
export async function recordAssistantMessage(chatId, content) {
  try {
    if (!chatId || !content) return;
    const key = `history:${chatId}`;
    const stored = await kv.get(key);
    const past = Array.isArray(stored) ? stored : [];
    await kv.set(key, [...past, { role: 'assistant', content }].slice(-MAX_HISTORY_MESSAGES));
  } catch (e) {
    /* a failed memory write should never affect the message itself */
  }
}
