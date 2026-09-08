import { evaluate } from 'mathjs';
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, history = [], imageBase64 = null } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;

  // Vision requires a multimodal-capable model; text-only turns stay on the
  // fast reasoning model. Groq's vision models are still "Preview" status —
  // meaning they can be unavailable without notice — so we try a list in
  // order rather than hardcoding one that might 404.
  const VISION_MODELS = [
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct'
  ];
  let MODEL = imageBase64 ? VISION_MODELS[0] : 'openai/gpt-oss-120b';

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
    }
  ];

  // Tracks the most recent real image URL produced by a tool call this request,
  // so we can hand it to the caller directly instead of trusting the model to
  // relay it verbatim in its final text.
  let lastImageUrl = null;

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

  const systemPrompt = 'Your name is Proxi, a personal AI agent built by Samuel. If asked who you are, say you are Proxi — not ChatGPT or any other assistant. You have real tools available (web search, image generation, photo search, calculator, currency conversion, reading URLs, and image understanding) and should use them confidently when needed. When a tool returns an image, never write out the URL or markdown image syntax yourself — just reply with a brief natural caption. IMPORTANT FORMATTING RULE: you are replying inside a Telegram chat, not a document. Never use markdown syntax like **bold**, ### headers, backticks, or bullet dashes (-). Write in plain, natural sentences and short paragraphs like a person texting. For lists, use simple numbering (1., 2., 3.) or line breaks, not symbols. You may use an occasional relevant emoji for warmth or clarity, but do not overuse them.';

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
    for (let i = 0; i < 5; i++) { // max 5 tool-call loops
      let data;

      if (imageBase64 && i === 0) {
        // First call with an image: try each candidate vision model until
        // one actually works, since Groq's preview vision models can 404.
        let lastError = null;
        for (const candidate of VISION_MODELS) {
          data = await callGroq(candidate);
          if (data.choices) { MODEL = candidate; break; }
          lastError = data;
        }
        if (!data.choices) {
          return res.status(500).json({ error: 'Groq vision error (all vision models failed): ' + JSON.stringify(lastError) });
        }
      } else {
        data = await callGroq(MODEL);
        if (!data.choices) {
          return res.status(500).json({ error: 'Groq error: ' + JSON.stringify(data) });
        }
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
      return res.status(200).json({ reply: choice.content, imageUrl: lastImageUrl, history: messages });
    }
    return res.status(200).json({ reply: "Reached max tool-call loops.", imageUrl: lastImageUrl, history: messages });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
