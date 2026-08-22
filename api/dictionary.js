// GemAir serverless — free dictionary (dictionaryapi.dev, no key)
const { guard, fetchJson } = require('./_lib/http');

module.exports = async (req, res) => {
  if (guard(req, res)) return;
  const word = (req.query.word || '').trim().slice(0, 64);
  if (!word) return res.status(400).json({ error: 'word is required' });
  try {
    const d = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!Array.isArray(d) || !d[0]) return res.json({ error: 'No definition found for "' + word + '".' });
    const m = d[0].meanings && d[0].meanings[0];
    const def = m && m.definitions && m.definitions[0];
    return res.json({
      word: d[0].word,
      phonetic: d[0].phonetic || '',
      partOfSpeech: m ? m.partOfSpeech : '',
      definition: def ? def.definition : '',
      example: def && def.example ? def.example : ''
    });
  } catch (e) {
    if (e.isTimeout || /HTTP_404/.test(e.message)) return res.json({ error: 'No definition found for "' + word + '".' });
    return res.status(500).json({ error: e.message });
  }
};
