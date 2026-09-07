import pdfParse from 'pdf-parse';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const update = req.body;
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;
  const document = update.message?.document;
  const caption = update.message?.caption;

  if (!chatId) return res.status(200).send('OK');

  const historyKey = `history:${chatId}`;
  const MAX_HISTORY_MESSAGES = 20; // keep the last ~10 exchanges

  async function loadHistory() {
    const stored = await kv.get(historyKey);
    return Array.isArray(stored) ? stored : [];
  }

  async function saveHistory(fullMessages) {
    // Strip the system message the agent always re-adds itself, so it
    // doesn't get duplicated next time this history is loaded back in.
    // Also cap individual message size — a full PDF dump sitting in memory
    // gets resent on every future turn otherwise, quickly hitting Groq's
    // per-minute token limit.
    const MAX_MSG_CHARS = 2000;
    const trimmed = fullMessages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (typeof m.content === 'string' && m.content.length > MAX_MSG_CHARS) {
          return { ...m, content: m.content.slice(0, MAX_MSG_CHARS) + ' [...trimmed from memory...]' };
        }
        return m;
      })
      .slice(-MAX_HISTORY_MESSAGES);
    await kv.set(historyKey, trimmed);
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

  // The agent tells us directly via `imageUrl` when a real image was produced —
  // we no longer trust the model's own text to signal that.
  async function deliverReply(data) {
    if (data.imageUrl) {
      await sendPhoto(data.imageUrl, cleanCaption(data.reply));
    } else {
      await sendMessage(data.reply || data.error || "Something went wrong.");
    }
  }

  async function askAgent(message, history) {
    const base = `https://${req.headers.host}`;
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history })
    });
    return await agentRes.json();
  }

  try {
    // --- PDF document upload ---
    if (document) {
      const isPdf = document.mime_type === 'application/pdf' ||
                    document.file_name?.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        await sendMessage("I can only read PDF documents right now.");
        return res.status(200).send('OK');
      }

      await sendMessage("Reading your PDF...");

      const fileInfoRes = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${document.file_id}`);
      const fileInfo = await fileInfoRes.json();
      const filePath = fileInfo.result?.file_path;
      if (!filePath) {
        await sendMessage("Couldn't retrieve that PDF from Telegram.");
        return res.status(200).send('OK');
      }

      const fileRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
      const arrayBuffer = await fileRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      let extractedText;
      try {
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text?.trim();
      } catch (e) {
        await sendMessage("Couldn't read that PDF — it may be scanned/image-based rather than text.");
        return res.status(200).send('OK');
      }

      if (!extractedText) {
        await sendMessage("That PDF didn't contain any readable text.");
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
      await sendMessage("I can read text and PDF documents — send me one of those.");
      return res.status(200).send('OK');
    }

    if (text.trim().toLowerCase() === '/reset') {
      await kv.del(historyKey);
      await sendMessage("Memory cleared — starting fresh.");
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
