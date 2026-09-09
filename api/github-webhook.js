// Receives GitHub's push webhook and summarizes it on Telegram. Verifies
// GitHub's HMAC signature using the raw request body — Vercel's automatic
// JSON parsing would re-serialize the body slightly differently, breaking
// signature verification, so body parsing is disabled here on purpose.
import crypto from 'crypto';

export const config = {
  api: { bodyParser: false }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.DAILY_CHAT_ID;
  const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

  const rawBody = await getRawBody(req);

  if (WEBHOOK_SECRET) {
    const signature = req.headers['x-hub-signature-256'];
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
    const sigBuffer = Buffer.from(signature || '');
    const digestBuffer = Buffer.from(digest);
    if (sigBuffer.length !== digestBuffer.length || !crypto.timingSafeEqual(sigBuffer, digestBuffer)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.headers['x-github-event'];
  if (event !== 'push') {
    return res.status(200).json({ skipped: `ignored event: ${event}` });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const repo = body.repository?.full_name || 'unknown repo';
  const pusher = body.pusher?.name || 'someone';
  const commits = body.commits || [];
  const commitLines = commits.map(c => `- ${c.message} (${c.id?.slice(0, 7)})`).join('\n');

  const message = `GitHub push to ${repo} by ${pusher}:\n\n${commitLines || 'No commit details'}`;

  if (CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message })
    });
  }

  return res.status(200).json({ delivered: true });
}
