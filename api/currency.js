// GemAir serverless — free currency conversion (Frankfurter, no key)
const { guard, fetchJson } = require('./_lib/http');

module.exports = async (req, res) => {
  if (guard(req, res)) return;
  const amount = parseFloat(req.query.amount);
  const from = (req.query.from || 'USD').toUpperCase().slice(0, 3).replace(/[^A-Z]/g, '');
  const to = (req.query.to || 'INR').toUpperCase().slice(0, 3).replace(/[^A-Z]/g, '');
  if (isNaN(amount)) return res.status(400).json({ error: 'amount must be a number' });
  try {
    const d = await fetchJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if (!d.rates || d.rates[to] === undefined) return res.json({ error: 'Currency conversion failed (unsupported currency?).' });
    return res.json({ amount, from, to, result: Math.round(amount * d.rates[to] * 100) / 100, rate: d.rates[to] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
