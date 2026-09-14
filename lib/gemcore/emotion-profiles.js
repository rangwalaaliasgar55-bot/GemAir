'use strict';
/* ============================================================
   GemCore — Emotion Profiles (ported from AERA)
   ------------------------------------------------------------
   A superset of voice emotion profiles in the same delta format
   GemAir's TTS engine already uses (rate/pitch/volume offsets +
   pause seconds), extended with AERA's dialogue states, text→
   emotion classification, and a voice-state manager that tracks
   the user's sentiment and adapts Gem's tone turn by turn.
   ============================================================ */

// Deltas match renderer/tts-engine.js EMOTION_PRESETS semantics:
// rate/pitch/volume are offsets from the profile baseline; pause is seconds.
const EMOTION_PROFILES = {
  // — GemAir's original eight (kept identical so existing calls don't shift) —
  neutral:    { rate: 0,     pitch: 0,     volume: 0,    pause: 0 },
  happy:      { rate: 0.08,  pitch: 0.12,  volume: 0.05, pause: 0 },
  excited:    { rate: 0.14,  pitch: 0.18,  volume: 0.1,  pause: 0 },
  calm:       { rate: -0.08, pitch: -0.06, volume: -0.05, pause: 0.5 },
  sad:        { rate: -0.12, pitch: -0.12, volume: -0.05, pause: 0.75 },
  empathetic: { rate: -0.06, pitch: -0.04, volume: 0,    pause: 0.5 },
  urgent:     { rate: 0.12,  pitch: 0.06,  volume: 0.12, pause: 0 },
  confident:  { rate: 0.02,  pitch: -0.02, volume: 0.08, pause: 0 },
  // — AERA dialogue states (new) —
  attentive:  { rate: -0.04, pitch: 0.02,  volume: 0.02, pause: 0.25 }, // listening closely, slightly lifted
  deliberate: { rate: -0.10, pitch: -0.03, volume: 0.03, pause: 0.6 },  // thinking carefully, unhurried
  concerned:  { rate: -0.07, pitch: -0.05, volume: -0.02, pause: 0.6 }, // serious, softer
  apologetic: { rate: -0.09, pitch: -0.08, volume: -0.04, pause: 0.7 }, // sorry, gentle
  curious:    { rate: 0.04,  pitch: 0.08,  volume: 0.03, pause: 0.3 },  // interested, light lift
  celebratory:{ rate: 0.12,  pitch: 0.15,  volume: 0.12, pause: 0.2 },  // big win, bright
  stern:      { rate: -0.02, pitch: -0.06, volume: 0.05, pause: 0.4 }   // firm, serious warning
};

const EMOTION_SYNONYMS = {
  joyful: 'happy', cheerful: 'happy', glad: 'happy', pleased: 'happy',
  thrilled: 'excited', enthusiastic: 'excited', energetic: 'excited',
  serene: 'calm', relaxed: 'calm', soothing: 'calm',
  unhappy: 'sad', down: 'sad', depressed: 'sad', melancholy: 'sad',
  sympathetic: 'empathetic', caring: 'empathetic', warm: 'empathetic',
  alert: 'urgent', warning: 'urgent', critical: 'urgent', alarm: 'urgent',
  assured: 'confident', certain: 'confident',
  listening: 'attentive', focused: 'attentive',
  thoughtful: 'deliberate', careful: 'deliberate', methodical: 'deliberate',
  worried: 'concerned', serious: 'concerned',
  sorry: 'apologetic', regretful: 'apologetic',
  inquisitive: 'curious', intrigued: 'curious', wondering: 'curious',
  triumphant: 'celebratory', victorious: 'celebratory',
  firm: 'stern', strict: 'stern'
};

function normalizeEmotion(tag) {
  const key = String(tag || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EMOTION_PROFILES, key)) return key;
  if (EMOTION_SYNONYMS[key]) return EMOTION_SYNONYMS[key];
  return 'neutral';
}

function profileFor(tag) {
  return { ...EMOTION_PROFILES[normalizeEmotion(tag)] };
}

/** Classify outgoing text → the emotion Gem should speak it with. */
function classifyResponseEmotion(text) {
  const value = String(text || '');
  if (/\b(congratulations|you did it|nailed it|awesome work|well done|perfect)\b/i.test(value)) return 'celebratory';
  if (/\b(i('| a)?m sorry|my apologies|apologi[sz]e|my mistake|i was wrong)\b/i.test(value)) return 'apologetic';
  if (/\b(warning|caution|danger|careful|do not|don't (run|delete|share)|immediately)\b/i.test(value)) return 'stern';
  if (/\b(urgent|right now|asap|time[- ]sensitive|hurry)\b/i.test(value)) return 'urgent';
  if (/\b(i understand|that sounds (hard|tough|difficult)|i('?m)? here for you|you're not alone)\b/i.test(value)) return 'empathetic';
  if (/\b(let me think|here's my analysis|considering|step by step|first.*then)\b/i.test(value)) return 'deliberate';
  if (/\b(great question|interesting|tell me more|curious|what about)\b/i.test(value)) return 'curious';
  if (/\b(done|complete|finished|success|here you go|ready)\b/i.test(value)) return 'confident';
  if (/[!]{2,}|🎉|😄|🚀|💪|❤️/.test(value)) return 'excited';
  if (/[!]\b/.test(value) && /\b(great|nice|love|perfect|wonderful|excellent)\b/i.test(value)) return 'happy';
  return 'neutral';
}

/** Sentiment cues for the incoming user message. */
function classifyUserSentiment(text) {
  const value = String(text || '').trim();
  if (!value) return { sentiment: 'neutral', intensity: 0 };
  const frustration = /\b(stupid|idiot|useless|broken|doesn'?t work|not working|wrong again|frustrat\w*|annoy\w*|ugh|wtf|hate)\b/i.test(value);
  const sadness = /\b(sad|depress\w*|lonely|tired of|exhausted|hopeless|can'?t anymore|cry\w*|hurt)\b/i.test(value);
  const joy = /\b(love (it|this|you)|awesome|amazing|great job|thank you so much|perfect|happy|yay)\b/i.test(value);
  const anxiety = /\b(worried|anxious|nervous|scared|afraid|panic\w*|stress\w*|deadline|hurry)\b/i.test(value);
  const exclamations = (value.match(/!/g) || []).length;
  const caps = value.replace(/[^A-Z]/g, '').length / Math.max(1, value.replace(/[^a-z]/g, 'x').length);
  let sentiment = 'neutral';
  let intensity = 0;
  if (frustration) { sentiment = 'frustrated'; intensity = 0.7 + Math.min(0.3, exclamations * 0.1 + (caps > 0.5 ? 0.2 : 0)); }
  else if (sadness) { sentiment = 'sad'; intensity = 0.7; }
  else if (anxiety) { sentiment = 'anxious'; intensity = 0.6; }
  else if (joy) { sentiment = 'joyful'; intensity = 0.6 + Math.min(0.3, exclamations * 0.1); }
  else if (exclamations >= 2) { sentiment = 'energetic'; intensity = 0.4; }
  return { sentiment, intensity: Math.max(0, Math.min(1, intensity)) };
}

/** How Gem's base voice emotion should adapt to the user's state (AERA voice-state manager). */
function adaptEmotionToUserState(userState, baseEmotion = 'neutral') {
  if (!userState || !userState.sentiment || userState.sentiment === 'neutral') return baseEmotion;
  const intensity = userState.intensity || 0.5;
  switch (userState.sentiment) {
    case 'frustrated':
      return intensity >= 0.7 ? 'apologetic' : 'empathetic';
    case 'sad':
      return intensity >= 0.7 ? 'empathetic' : 'attentive';
    case 'anxious':
      return intensity >= 0.6 ? 'concerned' : 'calm';
    case 'joyful':
      return 'celebratory';
    case 'energetic':
      return 'happy';
    default:
      return baseEmotion;
  }
}

/** Suggested pre-speech delay (ms) — deliberate answers breathe first. */
function delayForEmotion(tag) {
  const profile = normalizeEmotion(tag);
  if (profile === 'deliberate') return 400;
  if (profile === 'concerned') return 350;
  if (profile === 'apologetic') return 400;
  if (profile === 'attentive') return 200;
  return 0;
}

/** Clamped prosody the TTS engine can apply directly. */
function prosodyFor(tag, { baseRate = 1.0, basePitch = 1.1, baseVolume = 1.0 } = {}) {
  const profile = profileFor(tag);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  return {
    rate: clamp(baseRate + profile.rate, 0.5, 1.5),
    pitch: clamp(basePitch + profile.pitch, 0.5, 1.5),
    volume: clamp(baseVolume + profile.volume, 0, 1),
    pause: Math.max(0, profile.pause)
  };
}

module.exports = {
  EMOTION_PROFILES,
  EMOTION_SYNONYMS,
  normalizeEmotion,
  profileFor,
  prosodyFor,
  delayForEmotion,
  classifyResponseEmotion,
  classifyUserSentiment,
  adaptEmotionToUserState
};
