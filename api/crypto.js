// GemAir serverless — free crypto prices (CoinGecko, with fallback)
const { guard, fetchJson } = require('./_lib/http');

const FALLBACKS = {
  bitcoin: { usd: 68450, inr: 5712000 },
  ethereum: { usd: 3420, inr: 285000 },
  solana: { usd: 178, inr: 14800 },
  dogecoin: { usd: 0.14, inr: 11.6 }
};

module.exports = async (req, res) => {
  if (guard(req, res)) return;
  const coin = (req.query.coin || 'bitcoin').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  try {
    const d = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd,inr`);
    if (!d[coin]) {
      // Unknown coin → honest miss, not a stale fake price.
      return res.json({ coin, error: 'unknown_coin' });
    }
    return res.json({ coin, usd: d[coin].usd, inr: d[coin].inr });
  } catch (e) {
    // Upstream down → cached reference price, BADGED as simulated so the UI
    // never presents it as LIVE (same honesty rule as weather/headlines).
    const fb = FALLBACKS[coin] || FALLBACKS.bitcoin;
    return res.json({ coin, usd: fb.usd, inr: fb.inr, simulated: true, error: 'price_feed_unavailable' });
  }
};
