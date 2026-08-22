// GemAir serverless — free translation (MyMemory, no key)
const { guard, fetchJson } = require('./_lib/http');

module.exports = async (req, res) => {
  if (guard(req, res)) return;
  const text = (req.query.text || '').trim().slice(0, 500);
  const to = (req.query.to || 'en').trim().slice(0, 8).replace(/[^a-zA-Z-]/g, '');
  const from = (req.query.from || '').trim().slice(0, 8).replace(/[^a-zA-Z-]/g, '');
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const pair = (from ? from + '|' : '') + (to || 'en');
    const d = await fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`);
    if (d.responseStatus === 200 && d.responseData && d.responseData.translatedText) {
      return res.json({ translation: d.responseData.translatedText, to, from: from || 'auto' });
    }
    return res.json({ error: 'Translation failed.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
