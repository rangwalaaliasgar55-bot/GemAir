// GemAir serverless — free weather (Open-Meteo, no key)
const CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Rain showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Storm + hail', 99: 'Storm + hail'
};

module.exports = async (req, res) => {
  const city = (req.query.city || '').trim();
  if (!city) return res.status(400).json({ error: 'city is required' });
  try {
    const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`).then(r => r.json());
    const loc = geo.results && geo.results[0];
    if (!loc) return res.json({ error: 'City not found: ' + city });
    const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`).then(r => r.json());
    const cw = w.current_weather || {};
    return res.json({
      city: loc.name + (loc.country ? ', ' + loc.country : ''),
      temperature: cw.temperature,
      windspeed: cw.windspeed,
      condition: CODES[cw.weathercode] || 'Unknown',
      units: '°C / km/h'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
