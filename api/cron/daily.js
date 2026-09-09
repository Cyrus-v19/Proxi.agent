// Triggered daily by Vercel Cron (see vercel.json). No incoming Telegram
// message exists here, so the target chat and city are fixed via env vars.
export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const SERPER_KEY = process.env.SERPER_API_KEY;
  const CHAT_ID = process.env.DAILY_CHAT_ID;
  const CITY = process.env.DAILY_CITY || 'Addis Ababa';

  if (!CHAT_ID) {
    return res.status(200).json({ skipped: 'DAILY_CHAT_ID not set yet' });
  }

  async function sendMessage(text) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });
  }

  let weatherLine = "Couldn't get today's weather.";
  let rainWarning = '';
  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(CITY)}&count=1`);
    const geo = await geoRes.json();
    const place = geo.results?.[0];
    if (place) {
      const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,weather_code&daily=precipitation_probability_max&timezone=auto`);
      const w = await wRes.json();
      if (w.current) {
        weatherLine = `${place.name}: ${w.current.temperature_2m}°C (feels like ${w.current.apparent_temperature}°C)`;

        // Chained step: decide whether to add a rain warning, rather than
        // just reporting raw numbers — WMO codes 51-67/80-82/95-99 = rain
        // or storms; precipitation_probability_max is today's forecast max.
        const code = w.current.weather_code;
        const rainCodes = new Set([51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99]);
        const chanceToday = w.daily?.precipitation_probability_max?.[0];
        if (rainCodes.has(code) || (chanceToday !== undefined && chanceToday >= 60)) {
          rainWarning = `\n\nBring an umbrella — ${chanceToday !== undefined ? chanceToday + '% chance of rain today.' : 'rain looks likely today.'}`;
        }
      }
    }
  } catch (e) { /* keep fallback line */ }

  let newsLine = "Couldn't get today's top headline.";
  try {
    const r = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'world news today' })
    });
    const data = await r.json();
    const top = data.news?.[0];
    if (top) newsLine = `${top.title} (${top.source || 'source'})`;
  } catch (e) { /* keep fallback line */ }

  const message = `Good morning! Here's your daily briefing.\n\nWeather — ${weatherLine}${rainWarning}\n\nTop headline — ${newsLine}`;
  await sendMessage(message);

  return res.status(200).json({ sent: true });
}
