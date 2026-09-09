// Called repeatedly by a QStash recurring schedule (one per active alert)
// every 30 minutes. Checks the live price via CoinGecko; if the target
// condition is met, sends the alert and deletes its own schedule so it
// stops repeating. If not met, does nothing — QStash fires it again later.
export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
  const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';

  if (req.query.secret !== REMINDER_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const { chatId, coinId, targetPrice, direction, scheduleId } = req.body || {};
  if (!chatId || !coinId || targetPrice === undefined || !direction || !scheduleId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const priceRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`);
    const priceData = await priceRes.json();
    const currentPrice = priceData[coinId]?.usd;

    if (currentPrice === undefined) {
      return res.status(200).json({ skipped: `No price data for ${coinId}` });
    }

    const triggered = direction === 'above' ? currentPrice >= targetPrice : currentPrice <= targetPrice;

    if (triggered) {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Price alert: ${coinId} is now $${currentPrice}, which is ${direction} your target of $${targetPrice}.`
        })
      });

      // Stop repeating now that it's triggered
      await fetch(`https://qstash.upstash.io/v2/schedules/${scheduleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${QSTASH_TOKEN}` }
      });

      return res.status(200).json({ triggered: true, currentPrice });
    }

    return res.status(200).json({ triggered: false, currentPrice });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
