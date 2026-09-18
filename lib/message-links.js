/* GemAir — prepare-message links (pure).
   Composition, not sending: builds the platform URL with the text prefilled
   and returns it for the user's own send button. GemAir never presses send —
   messaging is a human-signed act. */
'use strict';

function cleanPhone(raw) {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  return /^\+?\d{7,15}$/.test(s) ? s.replace(/^\+/, '') : null;
}

function clipText(text) {
  return String(text || '').trim().slice(0, 800);
}

/** returns { ok, url, honest } or { ok:false, error } */
function build(channel, target, text) {
  const body = clipText(text);
  if (!body) return { ok: false, error: 'Nothing to compose — give the message text.' };
  const c = String(channel || 'whatsapp').toLowerCase();
  if (c === 'whatsapp') {
    const num = target ? cleanPhone(target) : null;
    if (target && !num) return { ok: false, error: 'WhatsApp needs a phone number in international format (e.g. +9198…), letters wont work.' };
    const url = 'https://wa.me/' + (num || '') + '?text=' + encodeURIComponent(body);
    return { ok: true, url, channel: 'whatsapp', sent: false, note: 'Opens WhatsApp with the message prefilled — YOU press send.' };
  }
  if (c === 'telegram') {
    const user = target ? String(target).replace(/^@/, '').replace(/[^\w]/g, '') : '';
    const url = user
      ? 'https://t.me/' + user + '?text=' + encodeURIComponent(body)   // direct chat link; text prefill support varies
      : 'https://t.me/share/url?url=&text=' + encodeURIComponent(body); // share sheet, text prefilled
    const honest = user
      ? 'Opens the Telegram chat (text prefill depends on the client — paste the copied text if needed) — YOU press send.'
      : 'Opens Telegram\'s share sheet with the text prefilled — YOU press send.';
    return { ok: true, url, channel: 'telegram', sent: false, note: honest };
  }
  return { ok: false, error: 'Unknown channel "' + c + '" — whatsapp or telegram now; others honestly unsupported without vendor APIs.' };
}

module.exports = { build, cleanPhone, clipText };
