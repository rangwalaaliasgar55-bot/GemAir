// GemAir serverless — free crypto prices (CoinGecko, no key)
module.exports = async (req, res) => {
  const coin = (req.query.coin || 'bitcoin').toLowerCase().trim();
  try {
    const d = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd,inr`).then(r => r.json());
    if (!d[coin]) return res.json({ error: 'Coin not found: ' + coin });
    return res.json({ coin, usd: d[coin].usd, inr: d[coin].inr });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
