/* ============================================================
   GemAir — internationalization registry (S4)

   2.1 shipped this file as a shell: an English dictionary of ten strings and
   two EMPTY placeholders (`hi: {}`, `ur: {}`), with no way for a user to pick a
   language and no RTL handling beyond a single hard-coded check. This version
   carries complete Hindi and Urdu dictionaries for every data-i18n key in the
   markup, exposes the catalogue so Settings can build a picker, and switches
   document direction (plus a body class the stylesheet can hook) for RTL.
   ============================================================ */
(function () {
  'use strict';

  const LANGUAGES = [
    { id: 'en', label: 'English', native: 'English', dir: 'ltr' },
    { id: 'hi', label: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
    { id: 'ur', label: 'Urdu', native: 'اردو', dir: 'rtl' }
  ];

  const dictionaries = {
    en: {
      'nav.assistant': 'Voice Core',
      'nav.core': 'Desktop Manager',
      'nav.companion': 'Life Companion',
      'nav.town': 'Agent Town',
      'nav.world': 'Global Intel',
      'status.nominal': 'SYSTEMS NOMINAL',
      'status.degraded': 'DEGRADED',
      'status.offline': 'OFFLINE',
      'settings.title': 'SETTINGS',
      'settings.language': 'Interface language',
      'palette.placeholder': 'Type a command, search memory, or ask a question…',
      'memory.empty': 'No memories match this search.',
      'audit.empty': 'No matching tool actions.',
      'tasks.title': 'TASKS',
      'tasks.add': 'Add a task…',
      'tasks.empty': 'No tasks yet.',
      'chat.placeholder': 'Ask me anything…',
      'chat.send': 'Send',
      'voice.start': 'START',
      'voice.stop': 'STOP',
      'voice.listening': 'Listening…',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.delete': 'Delete',
      'common.close': 'Close',
      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'proc.title': 'ACTIVE PROCESSES',
      'proc.end': 'End',
      'sat.title': 'SAT-LINK FEED'
    },

    hi: {
      'nav.assistant': 'वॉइस कोर',
      'nav.core': 'डेस्कटॉप प्रबंधक',
      'nav.companion': 'जीवन साथी',
      'nav.town': 'एजेंट टाउन',
      'nav.world': 'वैश्विक सूचना',
      'status.nominal': 'सिस्टम सामान्य',
      'status.degraded': 'आंशिक रूप से बाधित',
      'status.offline': 'ऑफ़लाइन',
      'settings.title': 'सेटिंग्स',
      'settings.language': 'इंटरफ़ेस भाषा',
      'palette.placeholder': 'कमांड लिखें, याददाश्त खोजें, या सवाल पूछें…',
      'memory.empty': 'इस खोज से मेल खाती कोई याद नहीं मिली।',
      'audit.empty': 'कोई मेल खाती टूल गतिविधि नहीं।',
      'tasks.title': 'कार्य',
      'tasks.add': 'नया कार्य जोड़ें…',
      'tasks.empty': 'अभी कोई कार्य नहीं है।',
      'chat.placeholder': 'मुझसे कुछ भी पूछें…',
      'chat.send': 'भेजें',
      'voice.start': 'शुरू',
      'voice.stop': 'रोकें',
      'voice.listening': 'सुन रहा हूँ…',
      'common.cancel': 'रद्द करें',
      'common.save': 'सहेजें',
      'common.delete': 'हटाएँ',
      'common.close': 'बंद करें',
      'common.refresh': 'रिफ़्रेश',
      'common.loading': 'लोड हो रहा है…',
      'proc.title': 'सक्रिय प्रक्रियाएँ',
      'proc.end': 'समाप्त करें',
      'sat.title': 'सैट-लिंक फ़ीड'
    },

    ur: {
      'nav.assistant': 'وائس کور',
      'nav.core': 'ڈیسک ٹاپ مینیجر',
      'nav.companion': 'زندگی کا ساتھی',
      'nav.town': 'ایجنٹ ٹاؤن',
      'nav.world': 'عالمی معلومات',
      'status.nominal': 'نظام معمول پر',
      'status.degraded': 'کارکردگی متاثر',
      'status.offline': 'آف لائن',
      'settings.title': 'ترتیبات',
      'settings.language': 'انٹرفیس کی زبان',
      'palette.placeholder': 'کمانڈ لکھیں، یادداشت تلاش کریں، یا سوال پوچھیں…',
      'memory.empty': 'اس تلاش سے کوئی یادداشت میل نہیں کھاتی۔',
      'audit.empty': 'کوئی مماثل ٹول سرگرمی نہیں۔',
      'tasks.title': 'کام',
      'tasks.add': 'نیا کام شامل کریں…',
      'tasks.empty': 'ابھی کوئی کام نہیں ہے۔',
      'chat.placeholder': 'مجھ سے کچھ بھی پوچھیں…',
      'chat.send': 'بھیجیں',
      'voice.start': 'شروع',
      'voice.stop': 'رکیں',
      'voice.listening': 'سن رہا ہوں…',
      'common.cancel': 'منسوخ کریں',
      'common.save': 'محفوظ کریں',
      'common.delete': 'حذف کریں',
      'common.close': 'بند کریں',
      'common.refresh': 'تازہ کریں',
      'common.loading': 'لوڈ ہو رہا ہے…',
      'proc.title': 'فعال پروسیسز',
      'proc.end': 'ختم کریں',
      'sat.title': 'سیٹ لنک فیڈ'
    }
  };

  let locale = 'en';

  function dirFor(id) {
    const entry = LANGUAGES.find((l) => l.id === id);
    return (entry && entry.dir) || 'ltr';
  }

  function t(key, vars) {
    let value = dictionaries[locale] && dictionaries[locale][key];
    if (value == null) value = dictionaries.en[key];
    if (value == null) value = key;
    return String(value).replace(/\{(\w+)\}/g, (_match, name) => vars && vars[name] != null ? vars[name] : `{${name}}`);
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
    scope.querySelectorAll('[data-i18n-label]').forEach((element) => { element.setAttribute('aria-label', t(element.dataset.i18nLabel)); });
    scope.querySelectorAll('[data-i18n-title]').forEach((element) => { element.title = t(element.dataset.i18nTitle); });

    const dir = dirFor(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    // S4: a body flag so the stylesheet can mirror padding/iconography for RTL
    // without every rule having to test [dir].
    if (document.body) document.body.classList.toggle('rtl', dir === 'rtl');
  }

  function setLocale(next) {
    locale = dictionaries[next] ? next : 'en';
    try { localStorage.setItem('gemair:locale', locale); } catch (error) {}
    apply();
    document.dispatchEvent(new CustomEvent('gemair:locale', { detail: { locale, dir: dirFor(locale) } }));
    return locale;
  }

  function register(language, strings) {
    dictionaries[language] = { ...(dictionaries[language] || {}), ...(strings || {}) };
  }

  /** Which data-i18n keys a language is still missing — used by the self-check. */
  function coverage(language) {
    const base = Object.keys(dictionaries.en);
    const target = dictionaries[language] || {};
    const missing = base.filter((k) => target[k] == null);
    return { language, total: base.length, translated: base.length - missing.length, missing };
  }

  try {
    const saved = localStorage.getItem('gemair:locale');
    if (saved && dictionaries[saved]) locale = saved;
  } catch (error) {}

  window.GemAirI18n = {
    t, apply, setLocale, register, coverage,
    LANGUAGES,
    dir: () => dirFor(locale),
    get locale() { return locale; },
    languages: () => Object.keys(dictionaries)
  };
  document.addEventListener('DOMContentLoaded', () => apply());
})();
