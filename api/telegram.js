import pdfParse from 'pdf-parse';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const update = req.body;
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
      .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold**
      .replace(/\*(.*?)\*/g, '$1')       // *italic*
      .replace(/__(.*?)__/g, '$1')       // __bold__
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // `code`
      .replace(/^[-•]\s+/gm, '')          // leading bullet dashes
      .trim();
  }

  async function sendMessage(msg) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: stripMarkdown(msg) })
    });
  }

  async function sendPhoto(photoUrl, cap) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: stripMarkdown(cap) || '' })
    });
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

  async function sendDocument(content, filename, cap) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', stripMarkdown(cap) || '');
    form.append('document', new Blob([content], { type: 'text/plain' }), filename || 'file.txt');
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
      method: 'POST',
      body: form
    });
  }

  // The agent tells us directly via `imageUrl` when a real image was produced —
  // we no longer trust the model's own text to signal that.
  async function deliverReply(data) {
    if (data.reactionEmoji) await sendReaction(data.reactionEmoji);
    if (data.fileContent) {
      await sendDocument(data.fileContent, data.fileName, data.reply);
    } else if (data.imageUrl) {
      await sendPhoto(data.imageUrl, cleanCaption(data.reply));
    } else {
      await sendMessage(data.reply || data.error || "Something went wrong.");
    }
  }

  async function askAgent(message, history, imageBase64 = null) {
    const base = `https://${req.headers.host}`;
    const body = { message, history, chatId };
    if (imageBase64) body.imageBase64 = imageBase64;
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await agentRes.json();
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

  try {
    // --- Rate limiting, applies to every message type ---
    const withinLimit = await checkRateLimit();
    if (!withinLimit) {
      await sendMessage("You're sending messages a bit too fast — please wait a moment and try again.");
      return res.status(200).send('OK');
    }

    // --- Typing indicator, keeps re-pinging every 4s until we respond ---
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);
    res.on?.('finish', () => clearInterval(typingInterval));

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
      return res.status(200).send('OK');
    }

    // --- PDF or plain text document upload ---
    if (document) {
      const isPdf = document.mime_type === 'application/pdf' ||
                    document.file_name?.toLowerCase().endsWith('.pdf');
      const isTxt = document.mime_type === 'text/plain' ||
                    document.file_name?.toLowerCase().endsWith('.txt');
      if (!isPdf && !isTxt) {
        await sendMessage("I can only read PDF and plain text (.txt) documents right now.");
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
      return res.status(200).send('OK');
    }

    // --- Plain text message ---
    if (!text) {
      await sendMessage("I can read text, voice notes, photos, and PDF documents — send me one of those.");
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

    const pastHistory = await loadHistory();
    const data = await askAgent(text, pastHistory);
    await deliverReply(data);
    if (data.history) await saveHistory(data.history);
  } catch (err) {
    await sendMessage("Error: " + err.message);
  }

  return res.status(200).send('OK');
}
