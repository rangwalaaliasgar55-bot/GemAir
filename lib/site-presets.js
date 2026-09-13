'use strict';

// Named destinations keep common workflows usable without making users paste
// URLs. The list is intentionally explicit; arbitrary URLs still pass through
// the normal HTTPS validation in window-tools.
const SITE_PRESETS = Object.freeze({
  youtube: 'https://youtube.com',
  'youtube music': 'https://music.youtube.com',
  spotify: 'https://open.spotify.com',
  soundcloud: 'https://soundcloud.com',
  github: 'https://github.com',
  chatgpt: 'https://chatgpt.com',
  google: 'https://google.com',
  gmail: 'https://mail.google.com',
  calendar: 'https://calendar.google.com',
  docs: 'https://docs.google.com',
  drive: 'https://drive.google.com',
  maps: 'https://maps.google.com',
  keep: 'https://keep.google.com',
  notion: 'https://notion.so',
  slack: 'https://app.slack.com',
  discord: 'https://discord.com/app',
  figma: 'https://figma.com',
  canva: 'https://canva.com',
  reddit: 'https://reddit.com',
  instagram: 'https://instagram.com',
  linkedin: 'https://linkedin.com',
  netflix: 'https://netflix.com',
  twitch: 'https://twitch.tv',
  stackoverflow: 'https://stackoverflow.com',
  medium: 'https://medium.com',
  coursera: 'https://coursera.org',
  udemy: 'https://udemy.com',
  focusx: 'https://focusarx.site',
  focusarx: 'https://focusarx.site'
});

function resolveSitePreset(value) {
  const key = String(value || '').trim().toLowerCase().replace(/^www\./, '').replace(/\/$/, '');
  return SITE_PRESETS[key] || null;
}

module.exports = { SITE_PRESETS, resolveSitePreset };
