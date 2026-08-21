/* GemAir internationalization registry — English today, Urdu/Hindi-ready. */
(function () {
  'use strict';

  const dictionaries = {
    en: {
      'nav.assistant': 'Voice Core',
      'nav.core': 'Desktop Manager',
      'nav.companion': 'Life Companion',
      'nav.town': 'Agent Town',
      'nav.world': 'Global Intel',
      'status.nominal': 'SYSTEMS NOMINAL',
      'settings.title': 'SETTINGS',
      'palette.placeholder': 'Type a command, search memory, or ask a question…',
      'memory.empty': 'No memories match this search.',
      'audit.empty': 'No matching tool actions.'
    },
    // Translators can register complete dictionaries without changing app code.
    hi: {},
    ur: {}
  };
  let locale = 'en';

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
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ur' ? 'rtl' : 'ltr';
  }

  function setLocale(next) {
    locale = dictionaries[next] ? next : 'en';
    try { localStorage.setItem('gemair:locale', locale); } catch (error) {}
    apply();
    document.dispatchEvent(new CustomEvent('gemair:locale', { detail: { locale } }));
    return locale;
  }

  function register(language, strings) {
    dictionaries[language] = { ...(dictionaries[language] || {}), ...(strings || {}) };
  }

  try { locale = dictionaries[localStorage.getItem('gemair:locale')] ? localStorage.getItem('gemair:locale') : 'en'; } catch (error) {}
  window.GemAirI18n = { t, apply, setLocale, register, get locale() { return locale; }, languages: () => Object.keys(dictionaries) };
  document.addEventListener('DOMContentLoaded', () => apply());
})();
