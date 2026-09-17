/* renderer/instant-ack.js — it answers before it works.
 *
 * Concept port (no upstream code) of Mark-LIV's instant acknowledgment:
 * some replies used to open with seconds of silence because the assistant
 * was still composing a tool call — from the user's side, slow-to-write and
 * slow-to-run are the same silence. The rule: when a longer task starts,
 * say ONE short sentence naming what you're starting, in the user's
 * language, then do it.
 *
 * The picker is deliberately small and local:
 *   - table per language (en default; tr/hi/es/de/fr/ru/uk/el/pt shipped)
 *   - per task-kind (task/search/file/system/code/generic)
 *   - rotation so the same line never fires twice in a row
 *
 * Plain script: window.GemInstantAck in the renderer; vm-loaded by tests.
 */
(function () {
  'use strict';

  const LINES = {
    en: { task: ['On it.', 'Right away.', "I'm on it.", 'Working on it now.'],
          search: ['Let me look that up.', 'Searching now.', 'Checking that for you.'],
          file: ['On those files now.', 'Working on the files.'],
          system: ['Doing it now.', 'Right away.'],
          code: ['Digging into the code now.', 'On the code.'],
          generic: ['One moment.', 'Working on it.'] },
    tr: { task: ['Hallediyorum.', 'Hemen bakıyorum.', 'Şimdi yapıyorum.'],
          search: ['Arayıp buluyorum.', 'Şimdi bakıyorum.'],
          file: ['Dosyalarla ilgileniyorum.'],
          system: ['Hemen yapıyorum.'],
          code: ['Koda bakıyorum.'],
          generic: ['Bir saniye.'] },
    hi: { task: ['अभी कर रहा हूँ।', 'ठीक है, शुरू करता हूँ।'],
          search: ['अभी खोजता हूँ।', 'देखता हूँ एक मिनट।'],
          file: ['फ़ाइलें संभाल रहा हूँ।'],
          system: ['अभी करता हूँ।'],
          code: ['कोड देख रहा हूँ।'],
          generic: ['एक पल।'] },
    es: { task: ['En seguida.', 'Me pongo con ello.'],
          search: ['Lo busco ahora.', 'Déjame mirarlo.'],
          file: ['Con los archivos ahora.'],
          system: ['Lo hago ahora.'],
          code: ['Miro el código.'],
          generic: ['Un momento.'] },
    de: { task: ['Bin dran.', 'Mache ich sofort.'],
          search: ['Suche ich jetzt.', 'Ich schaue nach.'],
          file: ['Bin an den Dateien.'],
          system: ['Mache ich jetzt.'],
          code: ['Schaue in den Code.'],
          generic: ['Einen Moment.'] },
    fr: { task: ["Je m'en occupe.", 'Tout de suite.'],
          search: ['Je regarde ça.', 'Je cherche.'],
          file: ['Je m’occupe des fichiers.'],
          system: ['Je le fais maintenant.'],
          code: ['Je regarde le code.'],
          generic: ['Un instant.'] },
    ru: { task: ['Уже делаю.', 'Сейчас сделаю.'],
          search: ['Сейчас поищу.', 'Смотрю.'],
          file: ['Занимаюсь файлами.'],
          system: ['Выполняю.'],
          code: ['Смотрю код.'],
          generic: ['Один момент.'] },
    uk: { task: ['Вже роблю.', 'Зараз зроблю.'],
          search: ['Зараз пошукаю.', 'Дивлюся.'],
          file: ['Працюю з файлами.'],
          system: ['Виконую.'],
          code: ['Дивлюся код.'],
          generic: ['Одну мить.'] },
    el: { task: ['Το κάνω τώρα.', 'Αμέσως.'],
          search: ['Το ψάχνω τώρα.', 'Το κοιτάζω.'],
          file: ['Ασχολούμαι με τα αρχεία.'],
          system: ['Το κάνω.'],
          code: ['Κοιτάζω τον κώδικα.'],
          generic: ['Μια στιγμή.'] },
    pt: { task: ['Já estou nisso.', 'Imediatamente.'],
          search: ['Vou procurar agora.', 'Deixa eu ver.'],
          file: ['Cuidando dos arquivos.'],
          system: ['Fazendo agora.'],
          code: ['Olhando o código.'],
          generic: ['Um momento.'] }
  };

  const KIND_BY_TOOL = {
    run_desktop_task: 'task', run_coding_task: 'code',
    research: 'search', deep_research: 'search', web_search: 'search', fetch_webpage: 'search', search_files: 'file', search_youtube: 'search',
    organize_folder: 'file', move_files: 'file', rename_files: 'file', archive_old_files: 'file',
    create_folder_tree: 'file', find_duplicates: 'file', find_large_files: 'file',
    system_scan: 'system', optimize_gaming: 'system', close_app: 'system'
  };

  function normalizeLanguage(lang) {
    const code = String(lang || 'en').toLowerCase().split(/[-_]/)[0];
    return Object.prototype.hasOwnProperty.call(LINES, code) ? code : 'en';
  }

  function kindForTool(toolName) {
    return KIND_BY_TOOL[toolName] || 'generic';
  }

  /** Create a stateful picker that never repeats the last line it gave. */
  function createAckPicker() {
    let lastKey = '';
    let lastLine = '';
    /** pick({ language, tool, kind }) → { line, language, kind } */
    function pick(opts) {
      const o = opts || {};
      const language = normalizeLanguage(o.language);
      const kind = o.kind || (o.tool ? kindForTool(o.tool) : 'generic');
      const table = LINES[language];
      let pool = table[kind] && table[kind].length ? table[kind] : table.generic;
      let key = language + ':' + kind;
      let line = pool[Math.floor(Math.random() * pool.length)];
      if (key === lastKey && pool.length > 1) {
        let guard = pool.length + 1;
        while (line === lastLine && guard-- > 0) line = pool[Math.floor(Math.random() * pool.length)];
      }
      lastKey = key; lastLine = line;
      return { line, language, kind };
    }
    return { pick };
  }

  const api = { createAckPicker, kindForTool, normalizeLanguage, LANGUAGES: Object.keys(LINES), KIND_BY_TOOL };
  if (typeof window !== 'undefined') window.GemInstantAck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
