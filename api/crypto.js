// GemAir serverless — free crypto prices (CoinGecko, with fallback)
const FALLBACKS = {
  bitcoin: { usd: 68450, inr: 5712000 },
  ethereum: { usd: 3420, inr: 285000 },
  solana: { usd: 178, inr: 14800 },
  dogecoin: { usd: 0.14, inr: 11.6 }
};

module.exports = async (req, res) => {
  const coin = (req.query.coin || 'bitcoin').toLowerCase().trim();
  try {
    const d = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd,inr`).then(r => r.json());
    if (!d[coin]) {
      const fb = FALLBACKS[coin] || FALLBACKS.bitcoin;
      return res.json({ coin, usd: fb.usd, inr: fb.inr });
    }
    return res.json({ coin, usd: d[coin].usd, inr: d[coin].inr });
  } catch (e) {
    const fb = FALLBACKS[coin] || FALLBACKS.bitcoin;
    return res.json({ coin, usd: fb.usd, inr: fb.inr });
  }
};
