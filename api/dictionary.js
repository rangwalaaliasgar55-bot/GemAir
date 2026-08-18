// GemAir serverless — free dictionary (dictionaryapi.dev, no key)
module.exports = async (req, res) => {
  const word = (req.query.word || '').trim();
  if (!word) return res.status(400).json({ error: 'word is required' });
  try {
    const d = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`).then(r => r.json());
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
    return res.status(500).json({ error: e.message });
  }
};
