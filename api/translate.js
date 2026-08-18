// GemAI serverless — free translation (MyMemory, no key)
module.exports = async (req, res) => {
  const text = (req.query.text || '').trim();
  const to = (req.query.to || 'en').trim();
  const from = (req.query.from || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const pair = (from ? from + '|' : '') + to;
    const d = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`).then(r => r.json());
    if (d.responseStatus === 200 && d.responseData && d.responseData.translatedText) {
      return res.json({ translation: d.responseData.translatedText, to, from: from || 'auto' });
    }
    return res.json({ error: 'Translation failed.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
