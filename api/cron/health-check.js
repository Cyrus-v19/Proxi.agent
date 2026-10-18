import { kv } from '@vercel/kv';
import { checkHealth, summarizeProviders } from '../../lib/health.js';
import { logError } from '../../lib/errorlog.js';
import { cronAuthorized } from '../../lib/auth.js';

// Triggered daily by Vercel Cron. Probes every link in the provider chain
// (Groq, NVIDIA, Gemini — each with a real tiny completion on the model
// agent.js actually uses) plus the Telegram bot token. Stays silent when
// everything's fine; only messages the user when something needs a human,
// or when no provider can answer at all. Rate-limited providers are
// reported in the result but are not an alert — that's normal on free tiers.
//
// Every non-ok result is also written to the error log, and the full result
// is kept at health:last so "/errors" and her get_error_log tool can show it.
export default async function handler(req, res) {
  // Only Vercel Cron may trigger this — it spends real tokens on three
  // providers per run. See lib/auth.js (open until CRON_SECRET is set).
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.DAILY_CHAT_ID;

  // This URL is public, and each run spends a few tokens on three providers.
  // A repeat hit within a minute gets the previous result instead of
  // re-probing, so it can't be used to burn the free-tier quota.
  try {
    const raw = await kv.get('health:last');
    const last = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (last?.t && Date.now() - Date.parse(last.t) < 60000) {
      return res.status(200).json({ ...last, cached: true });
    }
  } catch (e) { /* no cache available — just run the check */ }

  const result = await checkHealth();

  try { await kv.set('health:last', JSON.stringify(result)); } catch (e) { /* best-effort */ }

  for (const r of [...Object.values(result.providers), result.telegram]) {
    if (r.status === 'ok' || r.status === 'unconfigured') continue;
    await logError(`health:${r.label.toLowerCase()}`, `${r.label} ${r.status}: ${r.detail}`, '', r.status === 'down' ? 'error' : 'warn');
  }
  if (!result.healthy) {
    const noProvider = result.issues.find(i => i.startsWith('No AI provider'));
    if (noProvider) await logError('health', noProvider);
  }

  if (!result.healthy && CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `Self-check found a problem:\n\n${result.issues.join('\n')}\n\nStatus: ${summarizeProviders(result)}.`
        })
      });
    } catch (e) {
      await logError('health', 'Could not send the self-check alert to Telegram', e.message);
    }
  }

  return res.status(200).json({ healthy: result.healthy, issues: result.issues, providers: result.providers, telegram: result.telegram, t: result.t });
}
