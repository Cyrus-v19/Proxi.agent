import pdfParse from 'pdf-parse';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const update = req.body;
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;
  const document = update.message?.document;
  const caption = update.message?.caption;

  if (!chatId) return res.status(200).send('OK');

  async function sendMessage(msg) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });
  }

  async function sendPhoto(photoUrl, cap) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: cap || '' })
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

  async function askAgent(message) {
    const base = `https://${req.headers.host}`;
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: [] })
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

      const data = await askAgent(combinedMessage);
      await deliverReply(data);
      return res.status(200).send('OK');
    }

    // --- Plain text message ---
    if (!text) {
      await sendMessage("I can read text and PDF documents — send me one of those.");
      return res.status(200).send('OK');
    }

    const data = await askAgent(text);
    await deliverReply(data);
  } catch (err) {
    await sendMessage("Error: " + err.message);
  }

  return res.status(200).send('OK');
}
