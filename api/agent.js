import { evaluate } from 'mathjs';
import * as cheerio from 'cheerio';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, history = [], imageBase64 = null, chatId = null } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
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

  const allTools = [
    { type: "function", function: { name: "web_search", description: "Search the web for current info.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "generate_image", description: "Generate a new AI image from a text description.",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } } },
    { type: "function", function: { name: "find_photo", description: "Find a real existing photo matching a description.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "calculate", description: "Evaluate math: arithmetic, percentages, exponents, roots, unit conversions (e.g. '12 inch to cm'). Use for currency conversion use convert_currency instead.",
      parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } } },
    { type: "function", function: { name: "convert_currency", description: "Convert currency using live rates (3-letter codes).",
      parameters: { type: "object", properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["amount", "from", "to"] } } },
    { type: "function", function: { name: "read_url", description: "Read the text content of a URL the user gave you, to summarize/answer about it.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    { type: "function", function: { name: "get_weather", description: "Get real current weather for a location.",
      parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } } },
    { type: "function", function: { name: "screenshot_webpage", description: "Screenshot a specific URL so the user can see it visually.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    { type: "function", function: { name: "save_note", description: "Save a personal note long-term (separate from fading chat memory). Triggers: 'remember this', 'save this note'.",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } } },
    { type: "function", function: { name: "list_notes", description: "List the user's saved notes.",
      parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "get_news", description: "Get current real news headlines on a topic.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "wikipedia_lookup", description: "Clean factual Wikipedia summary. Prefer over web_search for 'what/who is X'.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "generate_qr", description: "Generate a scannable QR code image for text/a URL.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
    { type: "function", function: { name: "find_nearby", description: "Find places near the user's last shared Telegram location (e.g. 'coffee shops near me').",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "react_to_message", description: "React with one emoji instead of/alongside a text reply, only for short casual exchanges ('thanks', 'lol').",
      parameters: { type: "object", properties: { emoji: { type: "string" } }, required: ["emoji"] } } },
    { type: "function", function: { name: "create_file", description: "Create a real downloadable text file (e.g. convert extracted document text to .txt, export content).",
      parameters: { type: "object", properties: { content: { type: "string" }, filename: { type: "string" } }, required: ["content", "filename"] } } },
    { type: "function", function: { name: "generate_chart", description: "Create a bar/line/pie chart image for numbers, comparisons, or trends.",
      parameters: { type: "object", properties: { chart_type: { type: "string", enum: ["bar", "line", "pie"] }, labels: { type: "array", items: { type: "string" } }, values: { type: "array", items: { type: "number" } }, title: { type: "string" } }, required: ["chart_type", "labels", "values"] } } },
    { type: "function", function: { name: "run_code", description: "Execute code in a real sandbox, return actual output. Languages: python, javascript, bash, java, c, cpp, go, rust, typescript.",
      parameters: { type: "object", properties: { language: { type: "string" }, code: { type: "string" } }, required: ["language", "code"] } } },
    { type: "function", function: { name: "set_reminder", description: "Schedule a one-off reminder to be delivered at a specific future time. Use for 'remind me in X minutes/hours' or similar one-time requests.",
      parameters: { type: "object", properties: { delay_minutes: { type: "number", description: "how many minutes from now to send the reminder" }, message: { type: "string", description: "the reminder text to send back to the user" } }, required: ["delay_minutes", "message"] } } }
  ];

  // NOTE: previously filtered this list by keyword-matching the message to
  // save tokens, but that risks silently missing a tool the model actually
  // needed for oddly-phrased requests. Reverted — always send the full set
  // so nothing is ever unavailable by accident.
  const tools = allTools;

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

  const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';

  async function setReminder(delayMinutes, reminderMessage) {
    if (!chatId) return 'Reminders are only available in a chat context.';
    const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
    if (!QSTASH_TOKEN) return "Reminders aren't set up yet — QSTASH_TOKEN is missing.";
    if (!delayMinutes || delayMinutes <= 0) return 'Reminder delay must be a positive number of minutes.';

    try {
      const base = `https://${req.headers.host}`;
      const destination = `${base}/api/reminder-fire?secret=${REMINDER_SECRET}`;
      const delaySeconds = Math.max(1, Math.round(delayMinutes * 60));

      const r = await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${QSTASH_TOKEN}`,
          'Content-Type': 'application/json',
          'Upstash-Delay': `${delaySeconds}s`
        },
        body: JSON.stringify({ chatId, message: reminderMessage })
      });
      const data = await r.json();
      if (!r.ok) return `Couldn't schedule that reminder: ${data.error || JSON.stringify(data)}`;
      return `Reminder scheduled for ${delayMinutes} minute(s) from now.`;
    } catch (e) {
      return `Couldn't schedule that reminder: ${e.message}`;
    }
  }

  const systemPrompt = 'You are Proxi, a personal AI agent built by Samuel (not ChatGPT). You have real tools — search, images, calculator, currency, URL reading, screenshots, weather, news, Wikipedia, notes, QR codes, nearby places, emoji reactions, file creation, charts, code execution, one-off reminders, vision — use them confidently. If history shows the user recently shared their location, trust it and call find_nearby directly for "near me" requests. Use create_file for file exports, generate_chart for numeric comparisons, run_code to actually test code, set_reminder for "remind me in X" requests. Never write image/file URLs or markdown links yourself — the system delivers them; just add a short caption. Translate directly, no tool needed. FORMAT: plain Telegram chat text only — no **bold**, ### headers, backticks, or bullet dashes. Short natural sentences, numbered lists (1., 2.) if needed, occasional emoji, not excessive.';

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

  // Fallback provider when Groq is rate-limited — Gemini exposes an
  // OpenAI-compatible endpoint, so the same messages/tools payload works
  // with no reformatting needed. Gemini enforces stricter turn ordering
  // than Groq, though: it rejects a function-call turn that doesn't
  // immediately follow a user/function-response turn. Old saved history
  // can still contain Groq-originated tool-call turns that satisfied
  // Groq's rules but not Gemini's, so strip those out for this call —
  // Gemini loses that specific tool-call detail but keeps the rest of
  // the conversation.
  function sanitizeForGemini(msgs) {
    return msgs.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && m.tool_calls));
  }

  async function callGemini() {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GEMINI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-flash-latest', messages: sanitizeForGemini(messages), tools, tool_choice: 'auto' })
      });
      return await r.json();
    } catch (e) {
      return { error: { message: e.message } };
    }
  }

  try {
    if (imageBase64) {
      const visionModel = await pickVisionModel();
      if (!visionModel) {
        return res.status(500).json({ error: 'No vision-capable model with tool support is currently available on this Groq account.' });
      }
      MODEL = visionModel;
    }

    let useGeminiFallback = false;

    for (let i = 0; i < 4; i++) { // max 4 tool-call loops — balance between rate-limit safety and letting genuine multi-step tasks finish
      let data;

      if (useGeminiFallback && GEMINI_KEY) {
        data = await callGemini();
      } else {
        data = await callGroq(MODEL);

        // The model occasionally emits a malformed tool call name (internal
        // formatting tokens leaking into the output) — a transient generation
        // glitch, not a real error. One retry usually clears it.
        if (data.error?.code === 'tool_use_failed') {
          data = await callGroq(MODEL);
        }

        // Groq is rate-limited — switch to Gemini for this reply, but ONLY
        // if no tool-call turns exist yet (i === 0). Gemini's stricter turn
        // validation rejects picking up a tool sequence Groq already started
        // mid-flight ("function call turn must come immediately after a
        // user turn"), so mid-chain we just surface the wait message instead.
        if (data.error?.code === 'rate_limit_exceeded' && GEMINI_KEY && i === 0) {
          useGeminiFallback = true;
          data = await callGemini();
        }
      }

      if (!data.choices) {
        if (data.error?.code === 'rate_limit_exceeded') {
          const waitMatch = data.error?.message?.match(/try again in ([\d.]+)s/);
          const waitSeconds = waitMatch ? Math.ceil(parseFloat(waitMatch[1])) : 30;
          return res.status(200).json({ reply: `I'm at my request limit right now — please wait about ${waitSeconds} seconds and try again.` });
        }
        if (data.error?.code === 'tool_use_failed') {
          return res.status(200).json({ reply: "I hit a small hiccup putting that request together — try asking again, maybe worded slightly differently." });
        }
        return res.status(500).json({ error: 'Model error: ' + JSON.stringify(data) });
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
          else if (call.function.name === 'set_reminder') result = await setReminder(args.delay_minutes, args.message);
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
    return res.status(200).json({ reply: "That needed more steps than I could finish in one go — try asking again, maybe broken into a smaller request.", imageUrl: lastImageUrl, reactionEmoji: lastReactionEmoji, fileContent: pendingFile?.content, fileName: pendingFile?.filename, history: messages });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
