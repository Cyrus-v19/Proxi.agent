// Temporary diagnostic endpoint — visit this URL directly in a browser
// to see exactly which models this Groq API key can actually access.
// Safe to leave in place; it only reveals model IDs, not the key itself.
export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${GROQ_KEY}` }
    });
    const data = await r.json();
    const ids = (data.data || []).map(m => m.id).sort();

    // Direct answer for the specific question: is kimi-k2 available, and
    // does it actually support tool calling (which Proxi needs)?
    const kimi = (data.data || []).find(m => m.id.toLowerCase().includes('kimi'));
    const kimiCheck = kimi
      ? { available: true, id: kimi.id, active: kimi.active, supportsTools: !!kimi.supported_features?.includes('tools'), supportedFeatures: kimi.supported_features }
      : { available: false };

    return res.status(200).json({ kimiCheck, modelIds: ids, raw: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
