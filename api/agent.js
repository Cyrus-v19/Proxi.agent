import { evaluate } from 'mathjs';
import * as cheerio from 'cheerio';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, history = [], imageBase64 = null, chatId = null } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;

  // Vision requires a multimodal-capable model; text-only turns stay on the
  // fast reasoning model. Groq's vision-capable models change without much
  // notice (whole models get pulled from an account overnight), so instead
  // of hardcoding a model name that might 404, we ask Groq's own /models
  // endpoint what THIS key actually has access to, and pick a real match.
  let MODEL = 'openai/gpt-oss-120b';

  async function pickVisionModel() {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${GROQ_KEY}` }
      });
      const data = await r.json();
      const candidates = (data.data || []).filter(m =>
        m.active &&
        Array.isArray(m.input_modalities) && m.input_modalities.includes('image') &&
        Array.isArray(m.supported_features) && m.supported_features.includes('tools')
      );
      return candidates[0]?.id || null;
    } catch (e) {
      return null;
    }
  }

  const tools = [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "search query" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "generate_image",
        description: "Generate a new AI image from a text description",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string", description: "description of the image to generate" } },
          required: ["prompt"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "find_photo",
        description: "Find a real existing photo from the internet matching a description",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "what to search for" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "calculate",
        description: "Evaluate a precise mathematical expression — arithmetic, percentages, exponents, roots, and physical unit conversions (e.g. '12 inch to cm', '5 kg to lb'). Always use this for any exact calculation instead of doing math yourself. For currency conversion use convert_currency instead.",
        parameters: {
          type: "object",
          properties: { expression: { type: "string", description: "the math expression to evaluate, e.g. '500 * 0.05' or '12 inch to cm'" } },
          required: ["expression"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "convert_currency",
        description: "Convert an amount from one currency to another using live exchange rates. Use 3-letter currency codes (USD, ETB, EUR, GBP, etc).",
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number", description: "amount to convert" },
            from: { type: "string", description: "3-letter currency code to convert from" },
            to: { type: "string", description: "3-letter currency code to convert to" }
          },
          required: ["amount", "from", "to"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_url",
        description: "Fetch and read the text content of a specific web page URL so you can summarize it or answer questions about it. Only use this when the user gives you an actual URL/link.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "the full URL to read, including https://" } },
          required: ["url"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current real weather for a specific location (city, town, etc).",
        parameters: {
          type: "object",
          properties: { location: { type: "string", description: "city or place name, e.g. 'Addis Ababa'" } },
          required: ["location"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "screenshot_webpage",
        description: "Take a visual screenshot of a specific web page URL so the user can see what it looks like, rather than just reading its text.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "the full URL to screenshot, including https://" } },
          required: ["url"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "save_note",
        description: "Save a short personal note for the user to remember long-term, separate from normal conversation memory (which fades). Use when the user says things like 'remember this', 'save this note', 'note that...'.",
        parameters: {
          type: "object",
          properties: { note: { type: "string", description: "the exact text to save as a note" } },
          required: ["note"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_notes",
        description: "List all of the user's previously saved notes. Use when they ask 'what are my notes', 'show my notes', etc.",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "get_news",
        description: "Get current real news headlines about a topic.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "topic to search news for" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "wikipedia_lookup",
        description: "Look up a clean factual summary of a topic from Wikipedia. Prefer this over web_search for 'what is X' / 'who is X' factual questions.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "topic to look up" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "generate_qr",
        description: "Generate a scannable QR code image for a piece of text or a URL.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "the text or URL to encode" } },
          required: ["text"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "find_nearby",
        description: "Find real places near the user's last shared location (e.g. 'coffee shops near me'). Only works if the user has shared their location with Telegram's location-share feature recently.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "what kind of place to look for, e.g. 'coffee shop', 'pharmacy'" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "react_to_message",
        description: "React to the user's message with a single emoji instead of, or in addition to, a text reply. Use sparingly, only for genuinely short/casual exchanges (e.g. user says 'thanks', 'lol', 'nice') where a reaction feels more natural than a full reply.",
        parameters: {
          type: "object",
          properties: { emoji: { type: "string", description: "a single emoji, e.g. 👍 🔥 😂 ❤️ 🙏" } },
          required: ["emoji"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_file",
        description: "Create a real downloadable text file for the user — e.g. converting extracted document text into a .txt file, saving generated content, or exporting something as a file instead of a chat message.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "the full text content of the file" },
            filename: { type: "string", description: "filename including extension, e.g. 'notes.txt'" }
          },
          required: ["content", "filename"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "generate_chart",
        description: "Create a quick visual chart (bar, line, or pie) to illustrate numbers, comparisons, or trends instead of just stating them as plain text.",
        parameters: {
          type: "object",
          properties: {
            chart_type: { type: "string", enum: ["bar", "line", "pie"], description: "type of chart" },
            labels: { type: "array", items: { type: "string" }, description: "labels for each data point" },
            values: { type: "array", items: { type: "number" }, description: "numeric values matching each label" },
            title: { type: "string", description: "optional chart title" }
          },
          required: ["chart_type", "labels", "values"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_code",
        description: "Execute a code snippet in a real sandbox and return its actual output — use this whenever the user wants to test, run, debug, or check what code actually does, rather than guessing. Supports common languages like python, javascript, bash, java, c, cpp, go, rust, typescript.",
        parameters: {
          type: "object",
          properties: {
            language: { type: "string", description: "language to run, e.g. 'python', 'javascript', 'bash'" },
            code: { type: "string", description: "the full code to execute" }
          },
          required: ["language", "code"]
        }
      }
    }
  ];

  // Tracks the most recent real image URL produced by a tool call this request,
  // so we can hand it to the caller directly instead of trusting the model to
  // relay it verbatim in its final text.
  let lastImageUrl = null;
  let lastReactionEmoji = null;
  let pendingFile = null; // { content, filename }

  async function webSearch(query) {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query })
    });
    const data = await r.json();
    const top = (data.organic || []).slice(0, 5).map(r => `${r.title}: ${r.snippet}`).join('\n');
    return top || 'No results found';
  }

  async function generateImage(prompt) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
    lastImageUrl = url;
    return `Image generated successfully. (The system will deliver it directly — just reply with a short caption, do not include the URL or markdown image syntax in your reply.)`;
  }

  async function findPhoto(query) {
    const r = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query })
    });
    const data = await r.json();
    const first = data.images?.[0];
    if (!first) return 'No photo found';
    lastImageUrl = first.imageUrl;
    return `Photo found successfully. (The system will deliver it directly — just reply with a short caption, do not include the URL or markdown image syntax in your reply.)`;
  }

  async function calculate(expression) {
    try {
      const result = evaluate(expression);
      return `Result: ${result}`;
    } catch (e) {
      return `Couldn't evaluate that expression: ${e.message}`;
    }
  }

  async function convertCurrency(amount, from, to) {
    try {
      const r = await fetch(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`);
      const data = await r.json();
      const rate = data.rates?.[to.toUpperCase()];
      if (data.result !== 'success' || !rate) {
        return `Couldn't get an exchange rate for ${from} to ${to}.`;
      }
      const converted = (amount * rate).toFixed(2);
      return `${amount} ${from.toUpperCase()} = ${converted} ${to.toUpperCase()} (rate: ${rate})`;
    } catch (e) {
      return `Currency conversion failed: ${e.message}`;
    }
  }

  async function readUrl(url) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProxiBot/1.0)' } });
      const html = await r.text();
      const $ = cheerio.load(html);
      $('script, style, nav, footer, header, noscript, svg').remove();
      let text = $('body').text().replace(/\s+/g, ' ').trim();
      const MAX_CHARS = 8000;
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '... [truncated]';
      return text || 'Could not extract readable text from that page.';
    } catch (e) {
      return `Couldn't read that URL: ${e.message}`;
    }
  }

  async function getWeather(location) {
    try {
      // Open-Meteo needs coordinates, so geocode the place name first — both free, no API key.
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`);
      const geo = await geoRes.json();
      const place = geo.results?.[0];
      if (!place) return `Couldn't find a location called "${location}".`;

      const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code`);
      const w = await wRes.json();
      const c = w.current;
      if (!c) return `Couldn't get weather for ${location}.`;

      return `Weather in ${place.name}, ${place.country || ''}: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h.`;
    } catch (e) {
      return `Weather lookup failed: ${e.message}`;
    }
  }

  async function screenshotWebpage(url) {
    try {
      const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&waitFor=2500`);
      const data = await r.json();
      const shotUrl = data.data?.screenshot?.url;
      if (!shotUrl) return `Couldn't screenshot that page.`;
      lastImageUrl = shotUrl;
      return `Screenshot captured successfully. (The system will deliver it directly — just reply with a short caption, do not include the URL or markdown image syntax in your reply. Note: some sites like TikTok/Instagram show a login wall or placeholder to automated tools regardless of wait time — mention this if the image looks blank or generic.)`;
    } catch (e) {
      return `Screenshot failed: ${e.message}`;
    }
  }

  async function saveNote(note) {
    if (!chatId) return 'Notes are only available in a chat context.';
    try {
      await kv.rpush(`notes:${chatId}`, note);
      return `Saved: "${note}"`;
    } catch (e) {
      return `Couldn't save that note: ${e.message}`;
    }
  }

  async function listNotes() {
    if (!chatId) return 'Notes are only available in a chat context.';
    try {
      const notes = await kv.lrange(`notes:${chatId}`, 0, -1);
      if (!notes || notes.length === 0) return 'No notes saved yet.';
      return notes.map((n, i) => `${i + 1}. ${n}`).join('\n');
    } catch (e) {
      return `Couldn't retrieve notes: ${e.message}`;
    }
  }

  async function getNews(query) {
    try {
      const r = await fetch('https://google.serper.dev/news', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query })
      });
      const data = await r.json();
      const top = (data.news || []).slice(0, 5).map(n => `${n.title} (${n.date || 'recent'}) — ${n.source || ''}`).join('\n');
      return top || 'No news found on that topic.';
    } catch (e) {
      return `News lookup failed: ${e.message}`;
    }
  }

  async function wikipediaLookup(query) {
    try {
      const searchRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`);
      const searchData = await searchRes.json();
      const title = searchData.query?.search?.[0]?.title;
      if (!title) return `No Wikipedia article found for "${query}".`;
      const sumRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
      const sum = await sumRes.json();
      return sum.extract ? `${sum.title}: ${sum.extract}` : `Found "${title}" but couldn't get a summary.`;
    } catch (e) {
      return `Wikipedia lookup failed: ${e.message}`;
    }
  }

  async function generateQr(text) {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(text)}`;
    lastImageUrl = url;
    return `QR code generated successfully. (The system will deliver it directly — just reply with a short caption, do not include the URL or markdown image syntax in your reply.)`;
  }

  async function findNearby(query) {
    if (!chatId) return 'Location lookups are only available in a chat context.';
    try {
      const loc = await kv.get(`location:${chatId}`);
      if (!loc) return "I don't have your location yet — share it with Telegram's location-share feature (paperclip icon → Location), then ask again.";
      const r = await fetch('https://google.serper.dev/places', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, ll: `@${loc.latitude},${loc.longitude},14z` })
      });
      const data = await r.json();
      const top = (data.places || []).slice(0, 5).map(p => `${p.title}${p.address ? ' — ' + p.address : ''}${p.rating ? ` (${p.rating}★)` : ''}`).join('\n');
      return top || 'No nearby places found for that.';
    } catch (e) {
      return `Nearby lookup failed: ${e.message}`;
    }
  }

  async function reactToMessage(emoji) {
    lastReactionEmoji = emoji;
    return `Will react with ${emoji}.`;
  }

  async function createFile(content, filename) {
    pendingFile = { content, filename: filename || 'file.txt' };
    return `File "${pendingFile.filename}" created successfully. (The system will deliver it directly — just reply with a short caption, do not repeat the file content in your reply.)`;
  }

  async function generateChart(chartType, labels, values, title) {
    const config = {
      type: chartType || 'bar',
      data: {
        labels,
        datasets: [{ label: title || '', data: values, backgroundColor: '#d4af37', borderColor: '#a9791f' }]
      },
      options: { plugins: { title: { display: !!title, text: title || '' } } }
    };
    const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
    lastImageUrl = url;
    return `Chart generated successfully. (The system will deliver it directly — just reply with a short caption, do not include the URL or markdown image syntax in your reply.)`;
  }

  async function runCode(language, code) {
    try {
      const runtimesRes = await fetch('https://emkc.org/api/v2/piston/runtimes');
      const runtimes = await runtimesRes.json();
      const lang = language.toLowerCase();
      const match = runtimes.find(r => r.language === lang || r.aliases?.includes(lang));
      if (!match) return `Unsupported or unrecognized language: "${language}".`;

      const execRes = await fetch('https://emkc.org/api/v2/piston/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: match.language,
          version: match.version,
          files: [{ content: code }]
        })
      });
      const result = await execRes.json();
      const stdout = result.run?.stdout || '';
      const stderr = result.run?.stderr || '';
      let out = stdout.trim();
      if (stderr.trim()) out += (out ? '\n\nErrors:\n' : 'Errors:\n') + stderr.trim();
      if (!out) out = '(Ran successfully with no output.)';
      const MAX_CHARS = 3000;
      if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + '\n...[output truncated]';
      return out;
    } catch (e) {
      return `Code execution failed: ${e.message}`;
    }
  }

  const systemPrompt = 'Your name is Proxi, a personal AI agent built by Samuel. If asked who you are, say you are Proxi — not ChatGPT or any other assistant. You have real tools available (web search, image generation, photo search, calculator, currency conversion, reading URLs, screenshotting web pages, weather, news headlines, Wikipedia lookups, saving/listing personal notes, generating QR codes, finding nearby places, reacting with emoji, creating downloadable files, generating charts, running real code, and image understanding) and should use them confidently when needed. If the conversation history shows the user recently shared their location, trust that and confidently call find_nearby for "near me" style requests instead of asking them to share their location again — the tool itself will tell you if it genuinely has no location on file. When asked to convert something into a file (e.g. a document\'s text into .txt) or export content, use create_file rather than pasting the content in chat. When numbers would be clearer as a visual (comparisons, trends, breakdowns), use generate_chart instead of just listing them. When asked to run, test, or check the actual output of code, use run_code instead of guessing what it would print. When a tool returns an image or file, never write out the URL or markdown syntax yourself — just reply with a brief natural caption. You are also fully capable of accurate translation between languages directly — when asked to translate something, just give a natural, accurate translation in your reply, no tool needed. IMPORTANT FORMATTING RULE: you are replying inside a Telegram chat, not a document. Never use markdown syntax like **bold**, ### headers, backticks, or bullet dashes (-). Write in plain, natural sentences and short paragraphs like a person texting. For lists, use simple numbering (1., 2., 3.) or line breaks, not symbols. You may use an occasional relevant emoji for warmth or clarity, but do not overuse them.';

  // Build the user message — multimodal (text + image) when a photo was sent
  const userMessage = imageBase64
    ? {
        role: 'user',
        content: [
          { type: 'text', text: message },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }
    : { role: 'user', content: message };

  let messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    userMessage
  ];

  async function callGroq(model) {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' })
    });
    return groqRes.json();
  }

  try {
    if (imageBase64) {
      const visionModel = await pickVisionModel();
      if (!visionModel) {
        return res.status(500).json({ error: 'No vision-capable model with tool support is currently available on this Groq account.' });
      }
      MODEL = visionModel;
    }

    for (let i = 0; i < 5; i++) { // max 5 tool-call loops
      let data = await callGroq(MODEL);

      // The model occasionally emits a malformed tool call name (internal
      // formatting tokens leaking into the output) — a transient generation
      // glitch, not a real error. One retry usually clears it.
      if (data.error?.code === 'tool_use_failed') {
        data = await callGroq(MODEL);
      }

      if (!data.choices) {
        if (data.error?.code === 'rate_limit_exceeded') {
          return res.status(200).json({ reply: "I'm getting a lot of requests right now — give me about 20 seconds and try again." });
        }
        if (data.error?.code === 'tool_use_failed') {
          return res.status(200).json({ reply: "I hit a small hiccup putting that request together — try asking again, maybe worded slightly differently." });
        }
        return res.status(500).json({ error: 'Groq error: ' + JSON.stringify(data) });
      }

      const choice = data.choices[0].message;
      messages.push(choice);

      if (choice.tool_calls) {
        for (const call of choice.tool_calls) {
          const args = JSON.parse(call.function.arguments);
          let result;
          if (call.function.name === 'web_search') result = await webSearch(args.query);
          else if (call.function.name === 'generate_image') result = await generateImage(args.prompt);
          else if (call.function.name === 'find_photo') result = await findPhoto(args.query);
          else if (call.function.name === 'calculate') result = await calculate(args.expression);
          else if (call.function.name === 'convert_currency') result = await convertCurrency(args.amount, args.from, args.to);
          else if (call.function.name === 'read_url') result = await readUrl(args.url);
          else if (call.function.name === 'get_weather') result = await getWeather(args.location);
          else if (call.function.name === 'screenshot_webpage') result = await screenshotWebpage(args.url);
          else if (call.function.name === 'save_note') result = await saveNote(args.note);
          else if (call.function.name === 'list_notes') result = await listNotes();
          else if (call.function.name === 'get_news') result = await getNews(args.query);
          else if (call.function.name === 'wikipedia_lookup') result = await wikipediaLookup(args.query);
          else if (call.function.name === 'generate_qr') result = await generateQr(args.text);
          else if (call.function.name === 'find_nearby') result = await findNearby(args.query);
          else if (call.function.name === 'react_to_message') result = await reactToMessage(args.emoji);
          else if (call.function.name === 'create_file') result = await createFile(args.content, args.filename);
          else if (call.function.name === 'generate_chart') result = await generateChart(args.chart_type, args.labels, args.values, args.title);
          else if (call.function.name === 'run_code') result = await runCode(args.language, args.code);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: result
          });
        }
        continue; // loop again with tool results
      }

      // no more tool calls — final answer
      return res.status(200).json({ reply: choice.content, imageUrl: lastImageUrl, reactionEmoji: lastReactionEmoji, fileContent: pendingFile?.content, fileName: pendingFile?.filename, history: messages });
    }
    return res.status(200).json({ reply: "Reached max tool-call loops.", imageUrl: lastImageUrl, reactionEmoji: lastReactionEmoji, fileContent: pendingFile?.content, fileName: pendingFile?.filename, history: messages });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
