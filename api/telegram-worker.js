import pdfParse from 'pdf-parse';
import { kv } from '@vercel/kv';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { Document, Packer, Paragraph } from 'docx';
import { logError, errText, isOwner, buildErrorReport, clearErrors } from '../lib/errorlog.js';
import { enableMonitor, disableMonitor, monitorStatus } from '../lib/monitor.js';

// Everything below used to be the handler itself. It is now wrapped so that the
// HTTP response is sent only AFTER cleanup (releasing this chat's lock, stopping
// timers) has finished: on serverless, work that is still pending when the
// response goes out can be frozen mid-way, which would leave the chat locked.
export default async function handler(req, res, isTrustedInternalCall = false) {
  const ctl = { cleanup: null };
  let sent = null;
  const hold = {
    status(code) {
      return {
        send(body) { sent = ['send', code, body]; return hold; },
        json(body) { sent = ['json', code, body]; return hold; }
      };
    }
  };
  try {
    await processUpdate(req, hold, isTrustedInternalCall, ctl);
  } finally {
    try { await ctl.cleanup?.(); } catch (e) { /* cleanup is best-effort */ }
  }
  if (sent) { const [kind, code, body] = sent; return res.status(code)[kind](body); }
  return res.status(200).send('OK');
}

async function processUpdate(req, res, isTrustedInternalCall, ctl) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  // Only requests actually dispatched via QStash carry the secret in the
  // query string. The one exception is telegram.js's own inline fallback
  // (when QStash isn't configured or dispatch failed) — that's a direct
  // function call, not a real HTTP request, so it explicitly marks itself
  // as trusted instead.
  if (!isTrustedInternalCall) {
    const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';
    if (req.query?.secret !== REMINDER_SECRET) {
      return res.status(403).json({ error: 'Invalid secret' });
    }
  }

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const update = req.body;

  // The user pressed the stop button on the "Thinking" placeholder. This arrives
  // as its own update, handled by a separate invocation from the one doing the
  // work, so all it can do is leave a note (matching the draft id) for that one.
  const stopUpdate = update?.stopped_message_generation;
  if (stopUpdate?.chat?.id != null) {
    try { await kv.set(`stop:${stopUpdate.chat.id}`, stopUpdate.draft_id, { ex: 120 }); } catch (e) { /* best-effort */ }
    return res.status(200).send('OK');
  }

  const chatId = update.message?.chat?.id;
  const messageId = update.message?.message_id;
  const text = update.message?.text;
  const document = update.message?.document;
  const photo = update.message?.photo;
  const voice = update.message?.voice;
  const location = update.message?.location;
  const caption = update.message?.caption;

  if (!chatId) return res.status(200).send('OK');

  const historyKey = `history:${chatId}`;
  const rateLimitKey = `ratelimit:${chatId}`;
  const MAX_HISTORY_MESSAGES = 12; // keep the last ~6 exchanges — was 20, trimmed to reduce per-request token load
  const RATE_LIMIT_PER_MINUTE = 15;

  // Shows "Proxi is typing..." in Telegram. The indicator only lasts ~5s,
  // so for longer operations (multi-tool loops) we re-ping it periodically.
  async function sendTyping() {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    }).catch(() => {});
  }

  async function loadHistory() {
    const stored = await kv.get(historyKey);
    return Array.isArray(stored) ? stored : [];
  }

  async function saveHistory(fullMessages) {
    // Strip the system message the agent always re-adds itself, so it
    // doesn't get duplicated next time this history is loaded back in.
    const MAX_MSG_CHARS = 1200;
    const trimmed = fullMessages
      .filter(m => m.role !== 'system')
      .map(m => {
        // Multimodal messages (photo + text) carry a huge base64 image —
        // never persist that; keep just a short marker so future turns
        // know a photo was discussed, without resending megabytes of data.
        if (Array.isArray(m.content)) {
          const textPart = m.content.find(c => c.type === 'text')?.text || '';
          return { ...m, content: `${textPart} [an image was attached here and already analyzed — it is no longer available]`.trim() };
        }
        if (typeof m.content === 'string' && m.content.length > MAX_MSG_CHARS) {
          return { ...m, content: m.content.slice(0, MAX_MSG_CHARS) + ' [...trimmed from memory...]' };
        }
        return m;
      })
      .slice(-MAX_HISTORY_MESSAGES);
    await kv.set(historyKey, trimmed);
  }

  // Basic abuse/rate protection — caps how many messages one chat can send
  // per minute, so one person spamming can't burn through the shared
  // Groq/Serper quota for everyone else using this bot.
  async function checkRateLimit() {
    const count = await kv.incr(rateLimitKey);
    await kv.expire(rateLimitKey, 60);
    return count <= RATE_LIMIT_PER_MINUTE;
  }

  // Belt-and-braces: strip any markdown symbols the model still slips in,
  // since Telegram shows raw ** ### etc. as literal text, not formatting.
  function stripMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/^#{1,6}\s*/gm, '')       // ### headers
      // Only treat asterisks as markdown when they actually look like it:
      // opening one at a word start, closing one at a word end, no space
      // just inside. The old blanket rule turned "2*3*4 = 24" into
      // "234 = 24" and "5 * 3 * 2" into "5  3  2" — silently corrupting math.
      .replace(/(^|[\s(\[])\*\*(?=\S)(.+?)(?<=\S)\*\*(?=$|[\s).,!?:;\]])/g, '$1$2')   // **bold**
      .replace(/(^|[\s(\[])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?:;\]])/g, '$1$2')       // *italic*
      .replace(/__(.*?)__/g, '$1')       // __bold__
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // `code`
      .replace(/^[-•]\s+/gm, '')          // leading bullet dashes
      .trim();
  }

  // Telegram rejects any message over 4096 characters (and any photo/file
  // caption over 1024) with a 400 — and since nothing here checked the
  // response, a long reply simply never arrived: no error, no partial text.
  // Split at the nicest boundary available (paragraph, line, sentence, word)
  // so long answers arrive as a few natural messages instead of vanishing.
  function splitForTelegram(text, limit = 4000) {
    const chunks = [];
    let rest = text || '';
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      let cut = -1;
      for (const sep of ['\n\n', '\n', '. ', ' ']) {
        const idx = window.lastIndexOf(sep);
        if (idx >= limit * 0.5) { cut = idx + (sep === '. ' ? 1 : 0); break; } // keep the period with its sentence
      }
      if (cut === -1) cut = limit; // no good boundary at all — hard cut
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }
  // Media captions are capped at 1024. Keep what fits as the caption and
  // return the remainder so it can follow as a normal message.
  function fitCaption(text, limit = 1024) {
    if (!text || text.length <= limit) return { caption: text || '', overflow: '' };
    const caption = splitForTelegram(text, limit)[0] || text.slice(0, limit);
    return { caption, overflow: text.slice(caption.length).trim() };
  }
  // Splits code at line boundaries so no message cuts a line (or the block) in half.
  function splitCode(code, limit) {
    const parts = [];
    let cur = '';
    for (const line of code.split('\n')) {
      for (let i = 0; i < Math.max(line.length, 1); i += limit) {
        const seg = line.slice(i, i + limit);
        if (cur && cur.length + 1 + seg.length > limit) { parts.push(cur); cur = ''; }
        cur = cur ? cur + '\n' + seg : seg;
      }
    }
    if (cur) parts.push(cur);
    return parts;
  }

  // Turns a reply into one or more Telegram messages. A reply with no code
  // fence goes through exactly the old path (plain text, no entities). Fenced
  // code (```html ... ```) becomes a real Telegram "pre" block — boxed,
  // highlighted, with a copy button — and everything around it is plain text.
  function renderForTelegram(msg, limit = 4000) {
    const raw = msg || '';
    if (!raw.includes('```')) return splitForTelegram(stripMarkdown(raw), limit).map(text => ({ text, entities: [] }));

    const pieces = [];
    const addText = t => { const x = stripMarkdown(t); if (x) pieces.push({ text: x }); };
    const re = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
    let last = 0, m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) addText(raw.slice(last, m.index));
      let lang = m[1].trim().toLowerCase();
      let code = m[2];
      if (!/^[a-z0-9+#._-]{0,20}$/.test(lang)) { code = m[1] + '\n' + m[2]; lang = ''; } // code started on the fence line itself
      code = code.replace(/^\n+/, '').replace(/\s+$/, '');
      if (code) pieces.push({ code, lang });
      last = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < raw.length) addText(raw.slice(last));

    const out = [];
    let cur = { text: '', entities: [] };
    const flush = () => { if (cur.text) out.push(cur); cur = { text: '', entities: [] }; };
    for (const p of pieces) {
      const isCode = p.code !== undefined;
      for (const part of isCode ? splitCode(p.code, limit) : splitForTelegram(p.text, limit)) {
        let sep = cur.text ? '\n\n' : '';
        if (cur.text.length + sep.length + part.length > limit) { flush(); sep = ''; }
        const offset = cur.text.length + sep.length;
        cur.text += sep + part;
        if (isCode) cur.entities.push({ type: 'pre', offset, length: part.length, ...(p.lang ? { language: p.lang } : {}) });
      }
    }
    flush();
    return out;
  }

  async function sendMessage(msg) {
    for (const chunk of renderForTelegram(msg)) {
      const hasEntities = chunk.entities.length > 0;
      let r;
      try {
        r = await fetchWithTimeout(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk.text, ...(hasEntities ? { entities: chunk.entities } : {}) })
        }, 5000);
      } catch (e) {
        await logError('telegram', `sendMessage failed: ${e.message}`);
        throw e; // same behavior as before — the caller decides what to do
      }
      if (!r.ok) {
        // Telegram answered but refused the message — previously invisible.
        const body = await r.text().catch(() => '');
        await logError('telegram', `sendMessage rejected (HTTP ${r.status})`, body);
        if (hasEntities) {
          // Never lose the reply over formatting: send the same text unformatted.
          try {
            await fetchWithTimeout(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: chunk.text })
            }, 5000);
          } catch (e) { /* already logged above */ }
        }
      }
    }
  }

  // Bounds every outbound fetch so one slow/hanging host can't quietly eat
  // the worker's whole time budget (Vercel Hobby gives this function a hard
  // ~10s ceiling — see the reminder-duplication fix history above).
  async function fetchWithTimeout(url, options = {}, ms = 3500) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function trySendPhotoByUrl(photoUrl, cap) {
    try {
      const r = await fetchWithTimeout(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: stripMarkdown(cap) || '' })
      }, 3500);
      const data = await r.json();
      return data.ok;
    } catch (e) {
      return false;
    }
  }

  async function downloadImageBytes(url) {
    try {
      const r = await fetchWithTimeout(url, {
        headers: {
          // Some hosts (hotlink protection, odd redirects, missing headers)
          // reject Telegram's own server-side fetch but respond fine to a
          // normal request — fetching the bytes ourselves sidesteps that.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/*,*/*'
        }
      }, 3500);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > 0 ? buf : null;
    } catch (e) {
      return null;
    }
  }

  async function trySendPhotoBytes(buf, cap) {
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', stripMarkdown(cap) || '');
      form.append('photo', new Blob([buf]), 'photo.jpg');
      const r = await fetchWithTimeout(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: form }, 4000);
      const data = await r.json();
      return data.ok;
    } catch (e) {
      return false;
    }
  }

  async function trySendDocumentBytes(buf, cap) {
    // Telegram's sendPhoto enforces size/dimension limits (~10MB, width+height
    // <=10000px, aspect ratio <=20:1) that an arbitrary search-result image —
    // e.g. a large archival scan — can exceed even once we hold valid bytes.
    // sendDocument has none of that, and Telegram still renders an image
    // document with an inline preview, so this recovers photos that are
    // simply "too big/oddly shaped to be a photo" rather than unreachable.
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', stripMarkdown(cap) || '');
      form.append('document', new Blob([buf]), 'photo.jpg');
      const r = await fetchWithTimeout(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form }, 4000);
      const data = await r.json();
      return data.ok;
    } catch (e) {
      return false;
    }
  }

  async function sendPhoto(photoUrlOrUrls, cap) {
    const urls = (Array.isArray(photoUrlOrUrls) ? photoUrlOrUrls : [photoUrlOrUrls]).filter(Boolean);
    if (urls.length === 0) {
      await sendMessage(cap || "Couldn't find an image.");
      return;
    }
    // A caption over 1024 chars makes Telegram reject the photo itself — and
    // every retry below with it — which used to end in a misleading
    // "couldn't load the image" even though the image was fine.
    const full = stripMarkdown(cap || '');
    const { caption, overflow } = fitCaption(full);
    if (await deliverPhotoCandidates(urls, caption)) {
      if (overflow) await sendMessage(overflow);
      return;
    }
    // Every candidate failed every way — fall back to text + link so
    // something always reaches the user instead of total silence.
    await logError('telegram', 'Photo could not be delivered by any candidate; sent a text link instead', urls[0], 'warn');
    await sendMessage(`${full ? full + '\n\n' : ''}(Couldn't load the image directly — link: ${urls[0]})`);
  }
  async function deliverPhotoCandidates(urls, cap) {
    // Pass 1: let Telegram fetch each candidate directly — cheapest, and works
    // for the vast majority of hosts. Capped at 3 candidates and 3.5s each so
    // a few hung hosts can't burn the whole function timeout.
    for (const url of urls.slice(0, 3)) {
      if (await trySendPhotoByUrl(url, cap)) return true;
    }
    // Pass 2: download the bytes ourselves once per candidate, then try both
    // as a photo and (if that fails, e.g. on size/shape) as a document — this
    // recovers hotlink-blocked hosts AND oversized/odd-aspect images alike.
    for (const url of urls.slice(0, 3)) {
      const buf = await downloadImageBytes(url);
      if (!buf) continue;
      if (await trySendPhotoBytes(buf, cap)) return true;
      if (await trySendDocumentBytes(buf, cap)) return true;
    }
    return false;
  }

  // Strip any markdown image syntax, bracket markers, or raw URLs the model
  // might still slip into its text — belt-and-braces on top of the system prompt.
  function cleanCaption(text) {
    if (!text) return '';
    return text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[IMAGE_URL:[^\]]*\]/gi, '')
      .replace(/https?:\/\/\S+/g, '')
      .trim();
  }

  async function sendReaction(emoji) {
    if (!messageId) return;
    await fetch(`https://api.telegram.org/bot${TOKEN}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] })
    }).catch(() => {});
  }

  async function sendDocument(content, filename, cap, mimeType = 'text/plain') {
    // Same 1024-char caption limit as photos. Previously a chatty reply that
    // came with a file made Telegram reject the whole upload — and since the
    // response was never checked, the file you asked for just never arrived.
    const full = stripMarkdown(cap || '');
    const { caption, overflow } = fitCaption(full);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('document', new Blob([content], { type: mimeType }), filename || 'file.txt');
    let delivered = false;
    let reason = '';
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form });
      const data = await r.json();
      delivered = !!data.ok;
      reason = data.description || '';
    } catch (e) {
      reason = e.message;
    }
    if (delivered) {
      if (overflow) await sendMessage(overflow);
    } else {
      await logError('telegram', `sendDocument rejected: ${filename || 'file'}`, reason);
      await sendMessage(`${full ? full + '\n\n' : ''}(I built the file but Telegram wouldn't accept it${reason ? ': ' + reason : ''} — try asking again, or ask for it in a smaller/simpler form.)`);
    }
  }

  // Event-triggered automation: whenever a PDF or photo is processed, also
  // save a short auto-note — no clock involved, this just fires because of
  // what the user did, as a standing rule inside normal message handling.
  async function autoSaveNote(label, replyText) {
    if (!replyText) return;
    const snippet = replyText.length > 150 ? replyText.slice(0, 150) + '...' : replyText;
    try {
      await kv.rpush(`notes:${chatId}`, `[Auto-note from ${label}] ${snippet}`);
    } catch (e) { /* auto-notes are a bonus, never block the main reply on this */ }
  }

  // The agent tells us directly via `imageUrl` when a real image was produced —
  // we no longer trust the model's own text to signal that.
  // Safety net: some providers occasionally fail to format a tool call
  // properly and instead write it out as plain text (e.g. literally
  // "react_to_message\nemoji: 👋" as the reply). This catches that pattern,
  // actually applies the reaction, and strips the leaked text so the user
  // never sees raw tool-call syntax.
  function extractLeakedReaction(text) {
    if (!text) return null;
    const match = text.match(/react_to_message[\s\S]{0,20}emoji:\s*(\S+)/i);
    return match ? match[1] : null;
  }

  async function deliverReply(data) {
    if (data.stopped) {
      await sendMessage("Stopped. I dropped that answer.");
      return;
    }
    const leakedEmoji = !data.reactionEmoji ? extractLeakedReaction(data.reply) : null;
    if (leakedEmoji) {
      await sendReaction(leakedEmoji);
      const remaining = data.reply.replace(/react_to_message[\s\S]{0,20}emoji:\s*\S+/i, '').trim();
      if (remaining) await sendMessage(remaining);
      return;
    }
    if (data.reactionEmoji) await sendReaction(data.reactionEmoji);
    if (data.fileContent) {
      await sendDocument(data.fileContent, data.fileName, data.reply);
    } else if ((data.imageUrls && data.imageUrls.length) || data.imageUrl) {
      await sendPhoto(data.imageUrls?.length ? data.imageUrls : data.imageUrl, cleanCaption(data.reply));
    } else {
      await sendMessage(data.reply || data.error || "Something went wrong.");
    }
  }

  async function askAgent(message, history, imageBase64 = null, documentContext = null) {
    startThinking();
    try {
      return await askAgentInner(message, history, imageBase64, documentContext);
    } catch (e) {
      if (stopRequested) return { stopped: true }; // the user pressed stop; the aborted call is expected
      throw e;
    } finally {
      await stopThinking();
    }
  }

  async function askAgentInner(message, history, imageBase64 = null, documentContext = null) {
    const base = `https://${req.headers.host}`;
    let longTermMemory = [];
    try {
      longTermMemory = await kv.lrange(`memory:${chatId}`, 0, -1) || [];
    } catch (e) { /* long-term memory is a bonus, never block the reply on this */ }
    const body = { message, history, chatId, longTermMemory };
    if (imageBase64) body.imageBase64 = imageBase64;
    if (documentContext) body.documentContext = documentContext;
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      // The secret proves this call came from the worker, not from someone
      // who found the agent URL and typed in the owner's chat ID. Only the
      // owner-only get_error_log tool checks it (see getErrorLog in agent.js).
      headers: { 'Content-Type': 'application/json', 'x-proxi-secret': process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default' },
      body: JSON.stringify(body),
      signal: stopController.signal
    });

    // If agent.js itself times out or crashes at the platform level (e.g.
    // a slow external site during browsing), Vercel returns its own plain
    // "A server error has occurred" page instead of JSON — parsing that
    // as JSON throws and used to crash this whole request. Handle it as a
    // real, expected outcome instead of an unhandled exception.
    try {
      return await agentRes.json();
    } catch (e) {
      if (stopRequested) return { stopped: true };
      await logError('worker', `Agent call did not return JSON (HTTP ${agentRes.status}) — likely a timeout or crash in agent.js`);
      return { reply: "That took too long or hit an unexpected server issue — try again, maybe with a smaller request." };
    }
  }

  // Transcribes a voice note buffer using Groq's Whisper model
  async function transcribeAudio(buffer) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-large-v3-turbo');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form
    });
    const data = await r.json();
    return data.text || null;
  }

  // Downloads a Telegram file (by file_id) and returns it as a Buffer
  async function downloadTelegramFile(fileId) {
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo.result?.file_path;
    if (!filePath) return null;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
    const arrayBuffer = await fileRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ---- One message at a time per chat ---------------------------------------
  // Two messages processed side by side each load the same chat history and
  // the slower one overwrites the other's — which looked like Proxi ignoring
  // the latest message. A short-lived Redis lock makes the second wait its turn
  // (it is told so, not queued). The lock expires by itself after 45s, and is
  // refreshed while this invocation is alive, so a crashed run can't jam the chat.
  const lockKey = `lock:${chatId}`;
  const stopKey = `stop:${chatId}`;
  const lockToken = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const LOCK_TTL_SECONDS = 45;
  let lockHeld = false;
  let lockTimer = null;
  let typingInterval = null;

  async function acquireLock() {
    try {
      const got = await kv.set(lockKey, lockToken, { nx: true, ex: LOCK_TTL_SECONDS });
      if (got === null || got === undefined || got === false) return 'busy';
      lockHeld = true;
      lockTimer = setInterval(() => { Promise.resolve(kv.expire(lockKey, LOCK_TTL_SECONDS)).catch(() => {}); }, 15000);
      lockTimer.unref?.();
      return 'ok';
    } catch (e) {
      return 'open'; // can't reach the lock store — don't block her over that
    }
  }
  async function releaseLock() {
    clearInterval(lockTimer);
    if (!lockHeld) return;
    lockHeld = false;
    try { if ((await kv.get(lockKey)) === lockToken) await kv.del(lockKey); } catch (e) { /* expires on its own */ }
  }

  // ---- The "Thinking…" placeholder and stop button ----------------------------
  // sendMessageDraft with empty text shows Telegram's native animated
  // "Thinking" cube with a seconds counter, and can_stop adds a stop button.
  // A draft only lasts ~30s and is replaced by the next real message, so it is
  // re-sent every 12s while the AI works. Private chats only; if Telegram
  // refuses it, it is switched off for this message and everything else works.
  const draftId = (Date.now() % 2147483646) + 1;
  const stopController = new AbortController();
  let stopRequested = false;
  let canStop = true;
  let draftBroken = false;
  let thinking = null;

  async function pushDraft() {
    if (draftBroken) return;
    const call = withStop => fetchWithTimeout(`https://api.telegram.org/bot${TOKEN}/sendMessageDraft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, draft_id: draftId, text: '', ...(withStop ? { can_stop: true } : {}) })
    }, 3000);
    try {
      let r = await call(canStop);
      if (r.status === 429) return; // too frequent right now — the next tick will do
      if (!r.ok && canStop) { canStop = false; r = await call(false); } // maybe only the stop button is unsupported
      if (!r.ok) {
        draftBroken = true;
        await logError('telegram', `sendMessageDraft rejected (HTTP ${r.status}); thinking indicator turned off for this message`, await r.text().catch(() => ''), 'warn');
      }
    } catch (e) { /* a missed refresh is harmless */ }
  }

  async function checkStop() {
    try {
      const v = await kv.get(stopKey);
      if (v != null && String(v) === String(draftId)) {
        stopRequested = true;
        stopController.abort();
      }
    } catch (e) { /* can't check — try again next tick */ }
  }

  // The placeholder only appears if the answer is taking a while (default 3s).
  // A quick reply — a joke, a one-liner — then never shows it at all: Telegram
  // reserves extra room under the latest message while a draft is showing, which
  // on short replies just looked like a huge empty gap.
  function startThinking() {
    if (thinking) return;
    thinking = { n: 0, inflight: null, timer: null, delay: null };
    const begin = () => {
      thinking.delay = null;
      thinking.inflight = pushDraft();
      thinking.timer = setInterval(() => {
        thinking.n += 1;
        if (canStop) checkStop();
        if (thinking.n % 3 === 0) thinking.inflight = pushDraft();
      }, Number(process.env.THINKING_TICK_MS) || 4000);
      thinking.timer.unref?.();
    };
    const delayMs = process.env.THINKING_DELAY_MS !== undefined ? Number(process.env.THINKING_DELAY_MS) : 3000;
    if (!(delayMs > 0)) begin();
    else { thinking.delay = setTimeout(begin, delayMs); thinking.delay.unref?.(); }
  }
  async function stopThinking() {
    if (!thinking) return;
    clearTimeout(thinking.delay);
    clearInterval(thinking.timer);
    // Wait for an in-flight refresh so it can't land AFTER the real reply and
    // leave a stale "Thinking" behind.
    try { await thinking.inflight; } catch (e) { /* ignore */ }
    thinking = null;
  }

  ctl.cleanup = async () => {
    clearInterval(typingInterval);
    await stopThinking();
    await releaseLock();
  };

  // Commands that only read or report (and never touch chat history) answer
  // immediately, even while she is busy with something else.
  const bypassLock = !!text && /^\/(myid|errors?|monitor|help|start)(@\w+)?(\s|$)/i.test(text.trim());

  try {
    // --- Rate limiting, applies to every message type ---
    const withinLimit = await checkRateLimit();
    if (!withinLimit) {
      await sendMessage("You're sending messages a bit too fast — please wait a moment and try again.");
      return res.status(200).send('OK');
    }

    // --- Typing indicator, keeps re-pinging every 4s until we respond ---
    if (!bypassLock) {
      const lock = await acquireLock();
      if (lock === 'busy') {
        await sendMessage("Still working on your last message — I'll answer that first. Send this one again once I've replied.");
        return res.status(200).send('OK');
      }
    }

    sendTyping();
    typingInterval = setInterval(sendTyping, 4000);

    // --- Voice message ---
    if (voice) {
      await sendMessage("Listening to your voice note...");

      const buffer = await downloadTelegramFile(voice.file_id);
      if (!buffer) {
        await sendMessage("Couldn't retrieve that voice note from Telegram.");
        return res.status(200).send('OK');
      }

      const transcribed = await transcribeAudio(buffer);
      if (!transcribed) {
        await sendMessage("Couldn't transcribe that voice note.");
        return res.status(200).send('OK');
      }

      const pastHistory = await loadHistory();
      const data = await askAgent(transcribed, pastHistory);
      await deliverReply(data);
      if (data.history) await saveHistory(data.history);
      return res.status(200).send('OK');
    }

    // --- Shared location ---
    if (location) {
      const { latitude, longitude } = location;
      await kv.set(`location:${chatId}`, { latitude, longitude });
      await kv.expire(`location:${chatId}`, 3600); // remembered for 1 hour

      let weatherLine = '';
      try {
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature`);
        const w = await wRes.json();
        if (w.current) {
          weatherLine = ` It's currently ${w.current.temperature_2m}°C there (feels like ${w.current.apparent_temperature}°C).`;
        }
      } catch (e) { /* weather is a bonus, ignore failures */ }

      const ackText = `Got your location.${weatherLine} You can now ask me things like "coffee shops near me" for the next hour.`;
      await sendMessage(ackText);

      // This exchange skips the AI loop for speed, but still needs to land in
      // memory — otherwise the next message ("coffee shops near me") has no
      // idea location-sharing ever happened, even though the coordinates are
      // sitting in the database the whole time.
      const pastHistory = await loadHistory();
      const updatedHistory = [
        ...pastHistory,
        { role: 'user', content: 'I just shared my current location with you via Telegram.' },
        { role: 'assistant', content: ackText }
      ];
      await saveHistory(updatedHistory);

      return res.status(200).send('OK');
    }

    // --- Photo upload (vision) ---
    if (photo && photo.length > 0) {
      await sendMessage("Looking at your photo...");

      const largest = photo[photo.length - 1]; // Telegram sends smallest→largest
      const buffer = await downloadTelegramFile(largest.file_id);
      if (!buffer) {
        await sendMessage("Couldn't retrieve that photo from Telegram.");
        return res.status(200).send('OK');
      }
      const base64 = buffer.toString('base64');

      const pastHistory = await loadHistory();
      const userAsk = caption || 'What is in this image?';
      const data = await askAgent(userAsk, pastHistory, base64);
      await deliverReply(data);
      if (data.history) await saveHistory(data.history);
      await autoSaveNote('photo', data.reply);
      return res.status(200).send('OK');
    }

    // --- Spreadsheet upload (.xlsx) — read + optionally edit in place ---
    if (document && (document.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || document.file_name?.toLowerCase().endsWith('.xlsx'))) {
      await sendMessage("Reading your spreadsheet...");
      const buffer = await downloadTelegramFile(document.file_id);
      if (!buffer) {
        await sendMessage("Couldn't retrieve that file from Telegram.");
        return res.status(200).send('OK');
      }

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(buffer);
      } catch (e) {
        await sendMessage("Couldn't read that spreadsheet — it may be corrupted or in an unsupported format.");
        return res.status(200).send('OK');
      }

      let summary = '';
      workbook.eachSheet(sheet => {
        summary += `Sheet: ${sheet.name}\n`;
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            summary += `${cell.address}: ${cell.value}\n`;
          });
        });
      });
      const MAX_CHARS = 8000;
      if (summary.length > MAX_CHARS) summary = summary.slice(0, MAX_CHARS) + '\n[...truncated...]';

      const userAsk = caption || 'Summarize this spreadsheet for me.';
      const combinedMessage = `The user uploaded a spreadsheet named "${document.file_name || 'sheet.xlsx'}". Current contents:\n\n${summary}\n\nUser's request: ${userAsk}`;

      const pastHistory = await loadHistory();
      const data = await askAgent(combinedMessage, pastHistory, null, 'xlsx');

      if (data.spreadsheetEdits && data.spreadsheetEdits.length > 0) {
        for (const edit of data.spreadsheetEdits) {
          const sheet = workbook.getWorksheet(edit.sheet) || workbook.worksheets[0];
          if (sheet) sheet.getCell(edit.cell).value = edit.value;
        }
        const outBuffer = await workbook.xlsx.writeBuffer();
        await sendDocument(outBuffer, document.file_name || 'edited.xlsx', data.reply,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } else {
        await deliverReply(data);
      }
      if (data.history) await saveHistory(data.history);
      await autoSaveNote(document.file_name || 'spreadsheet', data.reply);
      return res.status(200).send('OK');
    }

    // --- Word document upload (.docx) — read + optionally rewrite text ---
    if (document && (document.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || document.file_name?.toLowerCase().endsWith('.docx'))) {
      await sendMessage("Reading your document...");
      const buffer = await downloadTelegramFile(document.file_id);
      if (!buffer) {
        await sendMessage("Couldn't retrieve that file from Telegram.");
        return res.status(200).send('OK');
      }

      let extractedText;
      try {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value?.trim();
      } catch (e) {
        await sendMessage("Couldn't read that document — it may be corrupted or in an unsupported format.");
        return res.status(200).send('OK');
      }

      if (!extractedText) {
        await sendMessage("That document didn't contain any readable text.");
        return res.status(200).send('OK');
      }

      const MAX_CHARS = 15000;
      const trimmedText = extractedText.length > MAX_CHARS
        ? extractedText.slice(0, MAX_CHARS) + '\n\n[...document truncated...]'
        : extractedText;

      const userAsk = caption || 'Summarize this document for me.';
      const combinedMessage = `The user uploaded a Word document named "${document.file_name || 'document.docx'}". Current text content:\n\n${trimmedText}\n\nUser's request: ${userAsk}`;

      const pastHistory = await loadHistory();
      const data = await askAgent(combinedMessage, pastHistory, null, 'docx');

      if (data.docxText) {
        const doc = new Document({
          sections: [{
            children: data.docxText.split('\n').map(line => new Paragraph(line))
          }]
        });
        const outBuffer = await Packer.toBuffer(doc);
        await sendDocument(outBuffer, document.file_name || 'edited.docx', data.reply,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } else {
        await deliverReply(data);
      }
      if (data.history) await saveHistory(data.history);
      await autoSaveNote(document.file_name || 'document', data.reply);
      return res.status(200).send('OK');
    }

    // --- PDF or plain text document upload ---
    if (document) {
      const isPdf = document.mime_type === 'application/pdf' ||
                    document.file_name?.toLowerCase().endsWith('.pdf');
      const isTxt = document.mime_type === 'text/plain' ||
                    document.file_name?.toLowerCase().endsWith('.txt');
      if (!isPdf && !isTxt) {
        await sendMessage("I can read PDF, .txt, .xlsx, and .docx documents — this one isn't one of those.");
        return res.status(200).send('OK');
      }

      await sendMessage(isPdf ? "Reading your PDF..." : "Reading your file...");

      const buffer = await downloadTelegramFile(document.file_id);
      if (!buffer) {
        await sendMessage("Couldn't retrieve that file from Telegram.");
        return res.status(200).send('OK');
      }

      let extractedText;
      if (isPdf) {
        try {
          const parsed = await pdfParse(buffer);
          extractedText = parsed.text?.trim();
        } catch (e) {
          await sendMessage("Couldn't read that PDF — it may be scanned/image-based rather than text.");
          return res.status(200).send('OK');
        }
      } else {
        extractedText = buffer.toString('utf8').trim();
      }

      if (!extractedText) {
        await sendMessage("That file didn't contain any readable text.");
        return res.status(200).send('OK');
      }

      const MAX_CHARS = 15000;
      const trimmedText = extractedText.length > MAX_CHARS
        ? extractedText.slice(0, MAX_CHARS) + '\n\n[...document truncated...]'
        : extractedText;

      const userAsk = caption || 'Summarize this document for me.';
      const combinedMessage = `The user sent a PDF document named "${document.file_name || 'document.pdf'}". Here is its extracted text:\n\n${trimmedText}\n\nUser's request about this document: ${userAsk}`;

      const pastHistory = await loadHistory();
      const data = await askAgent(combinedMessage, pastHistory);
      await deliverReply(data);
      if (data.history) await saveHistory(data.history);
      await autoSaveNote(document.file_name || 'document', data.reply);
      return res.status(200).send('OK');
    }

    // --- Plain text message ---
    if (!text) {
      await sendMessage("I can read text, voice notes, photos, PDFs, spreadsheets, and Word documents — send me one of those.");
      return res.status(200).send('OK');
    }

    if (text.trim().toLowerCase() === '/reset') {
      await kv.del(historyKey);
      await sendMessage("Memory cleared — starting fresh.");
      return res.status(200).send('OK');
    }

    if (text.trim().toLowerCase() === '/myid') {
      await sendMessage(`Your chat ID is: ${chatId}`);
      return res.status(200).send('OK');
    }

    // /errors [hours]  — recent errors and the last health check
    // /errors clear    — empty the log
    // Reads Redis directly (no AI call), so it still works when every
    // provider is rate-limited or down — exactly when you need it.
    // "/error" is accepted too (it is the natural thing to type — and when it
    // wasn't, the message fell through to the AI, which took minutes), as is
    // Telegram's "/errors@BotName" form.
    const cmdParts = text.trim().toLowerCase().split(/\s+/);
    if (/^\/errors?(@\w+)?$/.test(cmdParts[0])) {
      if (!isOwner(chatId)) {
        await sendMessage("The error log is only available to the bot owner.");
        return res.status(200).send('OK');
      }
      try {
        if (cmdParts[1] === 'clear') {
          await clearErrors();
          await sendMessage("Error log cleared.");
        } else {
          await sendMessage(await buildErrorReport({ hours: Number(cmdParts[1]) || 24 }));
        }
      } catch (e) {
        await sendMessage(`Couldn't read the error log: ${e.message}`);
      }
      return res.status(200).send('OK');
    }

    // /monitor on|off|status — the hourly self-check (owner only). It runs as
    // a QStash schedule, so this just creates/removes/looks up that schedule.
    if (/^\/monitor(@\w+)?$/.test(cmdParts[0])) {
      if (!isOwner(chatId)) {
        await sendMessage("The self-check is only available to the bot owner.");
        return res.status(200).send('OK');
      }
      const sub = cmdParts[1] || 'status';
      let out;
      if (sub === 'on') out = await enableMonitor(`https://${req.headers.host}`);
      else if (sub === 'off') out = await disableMonitor();
      else if (sub === 'status') out = await monitorStatus();
      else out = { text: 'Use /monitor on, /monitor off, or /monitor status.' };
      await sendMessage(out.text);
      return res.status(200).send('OK');
    }

    if (['/help', '/start'].includes(text.trim().toLowerCase())) {
      const helpText = `I'm Proxi, your personal AI agent. I remember our conversation, so you don't have to repeat yourself.

Here's what I can do:
1. Search the web and answer with current info
2. Look up Wikipedia summaries and live news headlines
3. Check real-time weather anywhere
4. Convert currencies with live rates
5. Do exact math, including unit conversions
6. Generate AI images or find real photos
7. Understand and describe any photo you send me
8. Listen to and transcribe voice notes
9. Read, summarize, and edit PDFs, text files, spreadsheets (.xlsx), and Word documents (.docx)
10. Read and summarize any web link
11. Screenshot a webpage
12. Generate QR codes
13. Find places near you, once you share your location
14. Create downloadable files and quick charts
15. Save personal notes and recall them anytime
16. Translate between languages
17. Run real code and give you the actual output — remembers state across runs, like a real coding session
18. React with emoji when a full reply isn't needed

Commands: /reset clears my memory and starts fresh. /myid shows your chat ID. /errors shows what has gone wrong lately (owner only). /monitor on turns on an hourly self-check that messages you only when something breaks (owner only). /help shows this again.

Just talk to me like a person — no special syntax needed.`;
      await sendMessage(helpText);
      return res.status(200).send('OK');
    }

    const pastHistory = await loadHistory();
    const data = await askAgent(text, pastHistory);
    await deliverReply(data);
    if (data.history) await saveHistory(data.history);
  } catch (err) {
    await logError('worker', `Unhandled exception: ${errText(err)}`);
    await sendMessage("Error: " + err.message);
  }

  return res.status(200).send('OK');
}
