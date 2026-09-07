export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, history = [] } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;

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
    }
  ];

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
    return `[IMAGE_URL: ${url}]`;
  }

  async function findPhoto(query) {
    const r = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query })
    });
    const data = await r.json();
    const first = data.images?.[0];
    return first ? `[IMAGE_URL: ${first.imageUrl}]` : 'No photo found';
  }

  let messages = [
    { role: 'system', content: 'Your name is Proxi, a personal AI agent built by Samuel. If asked who you are, say you are Proxi — not ChatGPT or any other assistant. You have real tools available (web search, image generation, photo search) and should use them confidently when needed.' },
    ...history,
    { role: 'user', content: message }
  ];

  try {
    for (let i = 0; i < 5; i++) { // max 5 tool-call loops
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages,
          tools,
          tool_choice: 'auto'
        })
      });
      const data = await groqRes.json();
      if (!data.choices) {
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
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result
          });
        }
        continue; // loop again with tool results
      }

      // no more tool calls — final answer
      return res.status(200).json({ reply: choice.content, history: messages });
    }
    return res.status(200).json({ reply: "Reached max tool-call loops.", history: messages });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
      }
