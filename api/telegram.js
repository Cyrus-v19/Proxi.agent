export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const update = req.body;
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;

  if (!chatId) return res.status(200).send('OK');

  async function sendMessage(msg) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });
  }

  if (!text) {
    await sendMessage("I can only read text for now — more coming soon.");
    return res.status(200).send('OK');
  }

  try {
    // Call our own agent endpoint
    const base = `https://${req.headers.host}`;
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: [] })
    });
    const data = await agentRes.json();
    await sendMessage(data.reply || data.error || "Something went wrong.");
  } catch (err) {
    await sendMessage("Error: " + err.message);
  }

  return res.status(200).send('OK');
      }
