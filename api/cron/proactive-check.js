import { kv } from '@vercel/kv';

// Runs once daily. She looks at her long-term memory and recent
// conversation, and decides whether there's one concrete, genuinely useful
// thing worth proactively offering to do. If so, she messages first —
// but doesn't actually DO anything yet. The proposal gets folded into her
// real conversation memory (same trick used for location-sharing earlier),
// so if you reply "yes", your very next message already has full context
// and she can act on it using her normal tools, normal conversation flow —
// no separate approval system needed.
export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.DAILY_CHAT_ID;

  if (!CHAT_ID) {
    return res.status(200).json({ skipped: 'DAILY_CHAT_ID not set yet' });
  }

  const historyKey = `history:${CHAT_ID}`;

  try {
    const pastHistory = (await kv.get(historyKey)) || [];
    const longTermMemory = (await kv.lrange(`memory:${CHAT_ID}`, 0, -1)) || [];

    const decisionPrompt = "Based on what you know about the user (your long-term memory) and your recent conversation, is there ONE concrete, genuinely useful thing you could proactively offer to help with right now — a real actionable suggestion (e.g. checking on something, following up on a note, setting something up), not a generic summary or check-in? Only suggest something if it's truly useful and not intrusive or repetitive. If yes, phrase it as a short natural message inviting a yes/no reply. If nothing genuinely stands out, respond with EXACTLY: NOTHING";

    const base = `https://${req.headers.host}`;
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: decisionPrompt, history: pastHistory, chatId: CHAT_ID, longTermMemory })
    });
    const data = await agentRes.json();
    const reply = (data.reply || '').trim();

    if (!reply || reply.toUpperCase().includes('NOTHING')) {
      return res.status(200).json({ proposed: false });
    }

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: reply })
    });

    // Fold this into her real conversation memory as her own unprompted
    // message (no fake preceding "user" turn — she genuinely spoke first
    // here). This way your next real reply has the context to follow through.
    const MAX_HISTORY_MESSAGES = 20;
    const updatedHistory = [...pastHistory, { role: 'assistant', content: reply }].slice(-MAX_HISTORY_MESSAGES);
    await kv.set(historyKey, updatedHistory);

    return res.status(200).json({ proposed: true, reply });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
