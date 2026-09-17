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
          'warn-cpu': ['Heads up — the processor has been running hot for a while.'],
          'warn-ram': ['Memory is nearly full — consider closing a few things.'],
          'warn-temp': ['The machine is running hot — give it some air if you can.'],
          'warn-battery': ['Battery is getting low — worth plugging in soon.'],
          generic: ['One moment.', 'Working on it.'] },
    tr: { task: ['Hallediyorum.', 'Hemen bakıyorum.', 'Şimdi yapıyorum.'],
          search: ['Arayıp buluyorum.', 'Şimdi bakıyorum.'],
          file: ['Dosyalarla ilgileniyorum.'],
          system: ['Hemen yapıyorum.'],
          code: ['Koda bakıyorum.'],
          'warn-cpu': ['Dikkat — işlemci bir süredir yüksek çalışıyor.'],
          'warn-ram': ['Bellek neredeyse dolu — birkaç şeyi kapatabilirsiniz.'],
          'warn-temp': ['Makine ısınıyor — biraz hava alması iyi olur.'],
          'warn-battery': ['Pil zayıflıyor — yakında şarja takmak iyi olur.'],
          generic: ['Bir saniye.'] },
    hi: { task: ['अभी कर रहा हूँ।', 'ठीक है, शुरू करता हूँ।'],
          search: ['अभी खोजता हूँ।', 'देखता हूँ एक मिनट।'],
          file: ['फ़ाइलें संभाल रहा हूँ।'],
          system: ['अभी करता हूँ।'],
          code: ['कोड देख रहा हूँ।'],
          'warn-cpu': ['ध्यान दें — प्रोसेसर काफी देर से तेज़ चल रहा है।'],
          'warn-ram': ['मेमोरी लगभग भर गई है — कुछ ऐप बंद कर दें।'],
          'warn-temp': ['मशीन गर्म हो रही है — हो सके तो हवा दें।'],
          'warn-battery': ['बैटरी कम हो रही है — चार्जर लगा लें।'],
          generic: ['एक पल।'] },
    es: { task: ['En seguida.', 'Me pongo con ello.'],
          search: ['Lo busco ahora.', 'Déjame mirarlo.'],
          file: ['Con los archivos ahora.'],
          system: ['Lo hago ahora.'],
          code: ['Miro el código.'],
          'warn-cpu': ['Atención: el procesador lleva un rato al máximo.'],
          'warn-ram': ['La memoria está casi llena — cierra algunas cosas.'],
          'warn-temp': ['La máquina se está calentando — dale aire si puedes.'],
          'warn-battery': ['Batería baja — conviene enchufar pronto.'],
          generic: ['Un momento.'] },
    de: { task: ['Bin dran.', 'Mache ich sofort.'],
          search: ['Suche ich jetzt.', 'Ich schaue nach.'],
          file: ['Bin an den Dateien.'],
          system: ['Mache ich jetzt.'],
          code: ['Schaue in den Code.'],
          'warn-cpu': ['Kurzer Hinweis — der Prozessor läuft schon eine Weile heiß.'],
          'warn-ram': ['Der Arbeitsspeicher ist fast voll — vielleicht ein paar Dinge schließen.'],
          'warn-temp': ['Das Gerät läuft heiß — etwas Luft würde helfen.'],
          'warn-battery': ['Der Akku wird schwach — bald anschließen.'],
          generic: ['Einen Moment.'] },
    fr: { task: ["Je m'en occupe.", 'Tout de suite.'],
          search: ['Je regarde ça.', 'Je cherche.'],
          file: ['Je m’occupe des fichiers.'],
          system: ['Je le fais maintenant.'],
          code: ['Je regarde le code.'],
          'warn-cpu': ['Petite alerte — le processeur tourne fort depuis un moment.'],
          'warn-ram': ['La mémoire est presque pleine — fermez quelques applications.'],
          'warn-temp': ['La machine chauffe — donnez-lui de l’air si possible.'],
          'warn-battery': ['La batterie faiblit — branchez-la bientôt.'],
          generic: ['Un instant.'] },
    ru: { task: ['Уже делаю.', 'Сейчас сделаю.'],
          search: ['Сейчас поищу.', 'Смотрю.'],
          file: ['Занимаюсь файлами.'],
          system: ['Выполняю.'],
          code: ['Смотрю код.'],
          'warn-cpu': ['Внимание — процессор давно работает на пределе.'],
          'warn-ram': ['Память почти заполнена — стоит закрыть лишнее.'],
          'warn-temp': ['Машина перегревается — дайте ей воздух.'],
          'warn-battery': ['Батарея разряжается — подключите зарядку.'],
          generic: ['Один момент.'] },
    uk: { task: ['Вже роблю.', 'Зараз зроблю.'],
          search: ['Зараз пошукаю.', 'Дивлюся.'],
          file: ['Працюю з файлами.'],
          system: ['Виконую.'],
          code: ['Дивлюся код.'],
          'warn-cpu': ['Увага — процесор уже давно на максимумі.'],
          'warn-ram': ['Пам’ять майже заповнена — закрийте зайве.'],
          'warn-temp': ['Машина перегрівається — дайте їй повітря.'],
          'warn-battery': ['Батарея слабшає — невдовзі варто підключити зарядку.'],
          generic: ['Одну мить.'] },
    el: { task: ['Το κάνω τώρα.', 'Αμέσως.'],
          search: ['Το ψάχνω τώρα.', 'Το κοιτάζω.'],
          file: ['Ασχολούμαι με τα αρχεία.'],
          system: ['Το κάνω.'],
          code: ['Κοιτάζω τον κώδικα.'],
          'warn-cpu': ['Προσοχή — ο επεξεργαστής δουλεύει σκληρά εδώ και ώρα.'],
          'warn-ram': ['Η μνήμη είναι σχεδόν γεμάτη — κλείστε μερικές εφαρμογές.'],
          'warn-temp': ['Το μηχάνημα ζεσταίνεται — δώστε του λίγο αέρα.'],
          'warn-battery': ['Η μπαταρία χαμηλώνει — καλό είναι να τη συνδέσετε στο ρεύμα.'],
          generic: ['Μια στιγμή.'] },
    pt: { task: ['Já estou nisso.', 'Imediatamente.'],
          search: ['Vou procurar agora.', 'Deixa eu ver.'],
          file: ['Cuidando dos arquivos.'],
          system: ['Fazendo agora.'],
          code: ['Olhando o código.'],
          'warn-cpu': ['Atenção — o processador está no limite há algum tempo.'],
          'warn-ram': ['A memória está quase cheia — feche algumas aplicações.'],
          'warn-temp': ['A máquina está a aquecer — dê-lhe algum ar.'],
          'warn-battery': ['A bateria está a ficar fraca — ligue o carregador em breve.'],
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
