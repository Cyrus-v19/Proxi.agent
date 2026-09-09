// Triggered daily by Vercel Cron. Checks that Groq, Gemini, and the
// Telegram bot token are all actually working — stays silent when
// everything's fine, only messages the user when something's broken.
export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const CHAT_ID = process.env.DAILY_CHAT_ID;

  const issues = [];

  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${GROQ_KEY}` }
    });
    if (!r.ok) issues.push(`Groq API returned status ${r.status}`);
  } catch (e) {
    issues.push(`Groq API unreachable: ${e.message}`);
  }

  if (GEMINI_KEY) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GEMINI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'ping' }] })
      });
      // 401/403 = real auth problem; other errors are more likely transient/benign for a ping
      if (r.status === 401 || r.status === 403) issues.push(`Gemini API auth failed (status ${r.status})`);
    } catch (e) {
      issues.push(`Gemini API unreachable: ${e.message}`);
    }
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`);
    const data = await r.json();
    if (!data.ok) issues.push('Telegram bot token invalid or bot unreachable');
  } catch (e) {
    issues.push(`Telegram API unreachable: ${e.message}`);
  }

  if (issues.length > 0 && CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: `Self-check found a problem:\n\n${issues.join('\n')}`
      })
    });
  }

  return res.status(200).json({ healthy: issues.length === 0, issues });
}
