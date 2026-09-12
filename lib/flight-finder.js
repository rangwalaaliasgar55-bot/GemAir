/* ============================================================
   GemAir — Flight Finder (ported concept from Mark-LIII's
   actions/flight_finder.py).

   Keyless: GemAir has no scraping/automation budget to run a full
   headless browser against Google Flights, so — like GemAir's other
   "web" tools (open_url, search_youtube) — this builds a correct,
   pre-filled Google Flights search URL and opens it, instead of
   silently scraping fares. Date parsing (today/tomorrow, weekday
   names, DD/MM/YYYY, ISO) is fully local + keyless.
   ============================================================ */
'use strict';

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
};

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function pad(n) { return String(n).padStart(2, '0'); }
function toIso(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }

function parseDate(raw, now = new Date()) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dmy = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  const lower = text.toLowerCase();
  if (lower.includes('today')) return toIso(now);
  if (lower.includes('tomorrow')) { const d = new Date(now); d.setDate(d.getDate() + 1); return toIso(d); }

  const inDays = lower.match(/in\s+(\d+)\s*days?/);
  if (inDays) { const d = new Date(now); d.setDate(d.getDate() + parseInt(inDays[1], 10)); return toIso(d); }

  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    if (lower.includes(name)) {
      const d = new Date(now);
      const delta = (idx - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + delta);
      return toIso(d);
    }
  }

  for (const [name, num] of Object.entries(MONTHS)) {
    if (lower.includes(name)) {
      const dayMatch = lower.match(/\b(\d{1,2})\b/);
      const day = dayMatch ? parseInt(dayMatch[1], 10) : 1;
      const year = num >= (now.getMonth() + 1) ? now.getFullYear() : now.getFullYear() + 1;
      return `${year}-${pad(num)}-${pad(day)}`;
    }
  }

  const parsed = Date.parse(text);
  if (!isNaN(parsed)) return toIso(new Date(parsed));
  return null;
}

const CABIN_LABEL = { economy: 'Economy', premium: 'Premium economy', business: 'Business', first: 'First' };

function buildGoogleFlightsUrl({ origin, destination, date, returnDate, cabin }) {
  const cabinLabel = CABIN_LABEL[String(cabin || 'economy').toLowerCase()] || 'Economy';
  const trip = returnDate
    ? `Flights from ${origin} to ${destination} on ${date} through ${returnDate} ${cabinLabel}`
    : `Flights from ${origin} to ${destination} on ${date} one way ${cabinLabel}`;
  return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(trip);
}

function findFlights(args, now = new Date()) {
  const origin = String((args && args.origin) || '').trim();
  const destination = String((args && args.destination) || '').trim();
  if (!origin || !destination) return { error: 'Provide both an origin and a destination.' };
  const date = parseDate(args && args.date, now);
  if (!date) return { error: `Could not understand the date: "${args && args.date}". Try YYYY-MM-DD, "tomorrow", or a weekday name.` };
  let returnDate = null;
  if (args && args.returnDate) {
    returnDate = parseDate(args.returnDate, now);
    if (!returnDate) return { error: `Could not understand the return date: "${args.returnDate}".` };
  }
  const cabin = String((args && args.cabin) || 'economy').toLowerCase();
  const url = buildGoogleFlightsUrl({ origin, destination, date, returnDate, cabin });
  return {
    ok: true,
    origin, destination, date, returnDate: returnDate || null,
    cabin: CABIN_LABEL[cabin] || 'Economy',
    url,
    note: 'Opening a pre-filled Google Flights search — live fares load in your browser (GemAir does not scrape fares).'
  };
}

module.exports = { parseDate, buildGoogleFlightsUrl, findFlights };
