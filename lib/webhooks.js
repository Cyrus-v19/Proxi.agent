// Webhook tool support: lets Proxi trigger automations (Make, Zapier, n8n,
// IFTTT...) that Samuel has set up himself.
//
// Safety design:
//  - Proxi can only call webhooks listed in the WEBHOOKS env var. The model
//    picks a NAME from that list; it can never supply a URL. So a malicious
//    web page or message cannot make her send data to an address of its choice.
//  - A webhook URL is effectively a password (anyone with it can trigger the
//    automation), so the URL is never put in a tool result, reply or log line.
//  - https only, no credentials in the URL, no localhost / private addresses.
//  - 15s timeout, redirects are not followed, small request and reply sizes.
//
// WEBHOOKS format: name=https://url pairs, separated by newlines, commas or
// spaces, e.g.
//   post-to-sheet=https://hook.eu2.make.com/abc123 send-email=https://hooks.zapier.com/hooks/catch/1/xyz/

export const WEBHOOK_TIMEOUT_MS = 15000;
export const MAX_BODY_BYTES = 20000;
export const MAX_REPLY_CHARS = 500;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true;
  // IPv4 written inside IPv6 ([::ffff:127.0.0.1] becomes ::ffff:7f00:1): refuse the whole range
  if (h.startsWith('::ffff:') || h.startsWith('64:ff9b:')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return false;
}

// Returns { hooks: { name: url }, problems: [names that were skipped] }.
// Never throws, and never returns a URL inside `problems`.
export function parseWebhooks(raw) {
  const hooks = {};
  const problems = [];
  for (const part of String(raw || '').split(/[\s,]+/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = eq > 0 ? part.slice(0, eq).trim().toLowerCase() : '';
    const url = eq > 0 ? part.slice(eq + 1).trim() : '';
    let ok = NAME_RE.test(name) && !(name in hooks);
    if (ok) {
      try {
        const u = new URL(url);
        ok = u.protocol === 'https:' && !u.username && !u.password && !isPrivateHost(u.hostname);
      } catch { ok = false; }
    }
    // Only a plain, safe-looking name is ever reported back; a mistyped entry
    // (for example a bare URL with no name) must not leak any of itself.
    if (ok) hooks[name] = url; else problems.push(/^[a-z0-9_-]{1,32}$/.test(name) ? name : '(invalid entry)');
  }
  return { hooks, problems };
}

// Sends one JSON POST. Always resolves to a string that is safe to show the
// model and the user (never contains the URL). Failures start with
// "Couldn't" so the agent loop logs them as warnings.
export async function callWebhook(name, url, { text, data } = {}, fetchImpl = globalThis.fetch) {
  const payload = { source: 'proxi', name, sent_at: new Date().toISOString() };
  if (typeof text === 'string' && text) payload.text = text;
  if (data !== undefined && data !== null) payload.data = data;
  let body;
  try { body = JSON.stringify(payload); } catch { return `Couldn't send to "${name}": the data couldn't be turned into JSON.`; }
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return `Couldn't send to "${name}": the payload is too big (limit ${MAX_BODY_BYTES} bytes).`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Proxi-Agent' },
      body,
      redirect: 'manual',
      signal: ctrl.signal
    });
    let reply = '';
    try { reply = String(await r.text()).replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY_CHARS); } catch { /* body unreadable: status is enough */ }
    if (r.status >= 300 && r.status < 400) return `Couldn't send to "${name}": the webhook tried to redirect (HTTP ${r.status}), which isn't followed.`;
    if (!r.ok) return `Couldn't send to "${name}": the webhook answered HTTP ${r.status}${reply ? ` — ${reply}` : ''}.`;
    return `Sent to "${name}" (HTTP ${r.status}).${reply ? ` It replied: ${reply}` : ''}`;
  } catch (e) {
    if (e?.name === 'AbortError') return `Couldn't send to "${name}": no answer within ${WEBHOOK_TIMEOUT_MS / 1000}s. It may or may not have run.`;
    return `Couldn't send to "${name}": the request failed (${e?.name || 'error'}).`;
  } finally {
    clearTimeout(timer);
  }
}
