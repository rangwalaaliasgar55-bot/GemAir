// GemAir serverless — free weather (Open-Meteo, with offline fallback).
//
// S1: the SAT-LINK FEED needs more than a temperature string, so this endpoint
// now also returns the resolved coordinates (for the rain-radar tile lookup)
// and, with ?mode=alerts, real advisories DERIVED from the Open-Meteo forecast.
// These are explicitly labelled as derived — GemAir never presents them as
// official government warnings.
const { guard, fetchJson: getJson } = require('./_lib/http');

const CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Rain showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Storm + hail', 99: 'Storm + hail'
};

/** Turn a raw Open-Meteo daily forecast into plain-language advisories. */
function deriveAlerts(daily) {
  const out = [];
  if (!daily || !Array.isArray(daily.time)) return out;
  for (let i = 0; i < Math.min(daily.time.length, 3); i++) {
    const day = daily.time[i];
    const code = (daily.weathercode || [])[i];
    const rain = (daily.precipitation_sum || [])[i];
    const wind = (daily.windspeed_10m_max || [])[i];
    const tmax = (daily.temperature_2m_max || [])[i];
    const tmin = (daily.temperature_2m_min || [])[i];

    if (code >= 95) out.push({ level: 'severe', day, title: 'Thunderstorm expected', detail: 'Lightning and squalls likely — avoid open ground and secure loose items.' });
    else if (rain >= 50) out.push({ level: 'severe', day, title: 'Very heavy rain', detail: `${Math.round(rain)} mm forecast — localised flooding possible.` });
    else if (rain >= 20) out.push({ level: 'warn', day, title: 'Heavy rain', detail: `${Math.round(rain)} mm forecast — carry rain gear and allow extra travel time.` });

    if (wind >= 60) out.push({ level: 'severe', day, title: 'Damaging winds', detail: `Gusts to ${Math.round(wind)} km/h.` });
    else if (wind >= 40) out.push({ level: 'warn', day, title: 'Strong winds', detail: `Gusts to ${Math.round(wind)} km/h.` });

    if (tmax >= 40) out.push({ level: 'severe', day, title: 'Extreme heat', detail: `${Math.round(tmax)}°C — hydrate and avoid midday sun.` });
    else if (tmax >= 35) out.push({ level: 'warn', day, title: 'Heat advisory', detail: `${Math.round(tmax)}°C expected.` });
    if (tmin <= 0) out.push({ level: 'warn', day, title: 'Freezing conditions', detail: `Low of ${Math.round(tmin)}°C — ice risk.` });
  }
  return out;
}

module.exports = async (req, res) => {
  if (guard(req, res)) return; // OPTIONS preflight / non-allowed origin
  const city = (req.query.city || '').trim();
  const mode = (req.query.mode || 'current').trim();
  if (!city) return res.status(400).json({ error: 'city is required' });
  res.setHeader('Cache-Control', 'public, max-age=300');

  try {
    const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
    const loc = geo.results && geo.results[0];
    if (!loc) return res.json({ error: 'City not found: ' + city });

    const label = loc.name + (loc.country ? ', ' + loc.country : '');
    const base = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}`;

    if (mode === 'alerts') {
      const w = await getJson(`${base}&daily=weathercode,precipitation_sum,windspeed_10m_max,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto`);
      const alerts = deriveAlerts(w.daily);
      return res.json({
        city: label, latitude: loc.latitude, longitude: loc.longitude,
        alerts, count: alerts.length,
        source: 'Derived from the Open-Meteo forecast — not an official government warning.'
      });
    }

    const w = await getJson(`${base}&current_weather=true`);
    const cw = w.current_weather || {};
    return res.json({
      city: label,
      latitude: loc.latitude,
      longitude: loc.longitude,
      temperature: cw.temperature,
      windspeed: cw.windspeed,
      weathercode: cw.weathercode,
      condition: CODES[cw.weathercode] || 'Clear sky',
      units: '°C / km/h'
    });
  } catch (e) {
    return res.status(503).json({
      ok: false,
      error: 'weather_unavailable',
      message: 'Live weather data is temporarily unavailable. Please retry.'
    });
  }
};
