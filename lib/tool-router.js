'use strict';

/**
 * Lightweight tool-catalog router.
 *
 * Large assistant catalogs cause context rot and poor tool selection. Inspired
 * by the routing patterns used by modern local-assistant projects, this is an
 * original, dependency-free scorer for GemAir's JavaScript architecture. It
 * always keeps a small utility core, then ranks tools against the current turn.
 */

const CORE_TOOLS = new Set([
  'get_current_time',
  'get_current_date',
  'calculate',
  'web_search',
  'search_memory'
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from',
  'get', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please',
  'the', 'this', 'to', 'use', 'want', 'with', 'you'
]);

const INTENT_HINTS = [
  { re: /\b(weather|forecast|temperature|rain|sunny|humidity)\b/i, tools: ['get_weather'] },
  { re: /\b(search|research|latest|news|current|verify|source|website|web page|wikipedia|youtube)\b/i, tools: ['web_search', 'fetch_webpage', 'search_wikipedia', 'search_youtube', 'verify_claim'] },
  { re: /\b(file|folder|directory|download|upload|document|read|write|rename|organize)\b/i, tools: ['list_directory', 'read_file', 'write_file', 'search_files', 'organize_folder', 'upload_file', 'download_file'] },
  { re: /\b(click|mouse|screen|screenshot|desktop|window|scroll|type|keyboard|press key)\b/i, tools: ['capture_agent_screen', 'describe_screen', 'move_mouse', 'mouse_click', 'type_text', 'press_key', 'scroll_mouse', 'take_screenshot', 'list_windows'] },
  { re: /\b(code|coding|repository|repo|git|debug|test|refactor|implement)\b/i, tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'run_command', 'run_coding_cli'] },
  { re: /\b(remind|reminder|schedule|later|tomorrow|calendar|appointment|event)\b/i, tools: ['set_reminder', 'list_reminders', 'add_calendar_event'] },
  { re: /\b(note|remember|memory|fact|preference|todo|to-do|goal)\b/i, tools: ['save_note', 'list_notes', 'remember_fact', 'search_memory', 'list_todos', 'add_todo', 'complete_todo', 'add_goal', 'list_goals', 'complete_goal'] },
  { re: /\b(email|mail|whatsapp|message|send|contact)\b/i, tools: ['send_email', 'open_whatsapp'] },
  { re: /\b(open|launch|application|app|browser|url|site)\b/i, tools: ['open_application', 'open_url', 'open_site'] },
  { re: /\b(volume|mute|sound|lock|sleep|shutdown|restart|system status|cpu|memory usage|battery|storage)\b/i, tools: ['control_volume', 'control_system', 'get_system_status', 'get_power_storage', 'system_scan'] },
  { re: /\b(translate|translation|language|define|meaning|dictionary)\b/i, tools: ['translate', 'define_word'] },
  { re: /\b(price|crypto|bitcoin|ethereum|currency|convert|exchange rate)\b/i, tools: ['get_crypto_price', 'convert_currency'] },
  { re: /\b(image|picture|photo|draw|generate art)\b/i, tools: ['generate_image', 'take_screenshot'] },
  { re: /\b(flight|fly|airport|trip|travel)\b/i, tools: ['find_flights'] },
  { re: /\b(game|steam|epic|update game)\b/i, tools: ['update_game', 'list_installed_epic_games'] },
  { re: /\b(mood|feel|feeling|wellness|affirmation|emotion)\b/i, tools: ['log_mood', 'get_mood_history', 'get_affirmation'] },
  { re: /\b(mode|focus|work mode|gaming mode|study mode|chill)\b/i, tools: ['apply_mode', 'list_modes', 'create_mode'] },
  { re: /\b(monitor|watch topic|alert me|track topic)\b/i, tools: ['add_topic_monitor', 'remove_topic_monitor', 'list_topic_monitors', 'check_topic_monitors'] }
];

function tokens(value) {
  return new Set(String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
}

function toolName(tool) {
  return tool && tool.function && typeof tool.function.name === 'string' ? tool.function.name : '';
}

function toolSearchText(tool) {
  if (!tool || !tool.function) return '';
  return [tool.function.name, tool.function.description, JSON.stringify(tool.function.parameters || {})].join(' ');
}

function selectRelevantTools(tools, messages, options = {}) {
  const catalog = Array.isArray(tools) ? tools.filter((tool) => toolName(tool)) : [];
  const limit = Math.max(8, Math.min(Number(options.limit) || 24, 40));
  if (catalog.length <= limit) return catalog.slice();

  const conversation = (Array.isArray(messages) ? messages : [])
    .slice(-6)
    .map((message) => message && typeof message.content === 'string' ? message.content : '')
    .join('\n');
  const queryTokens = tokens(conversation);
  const hinted = new Set();
  for (const hint of INTENT_HINTS) {
    if (hint.re.test(conversation)) hint.tools.forEach((name) => hinted.add(name));
  }

  const ranked = catalog.map((tool, index) => {
    const name = toolName(tool);
    const haystack = tokens(toolSearchText(tool));
    let score = CORE_TOOLS.has(name) ? 100 : 0;
    if (hinted.has(name)) score += 80;
    if (conversation.toLowerCase().includes(name.toLowerCase())) score += 120;
    for (const token of queryTokens) {
      if (haystack.has(token)) score += token.length >= 6 ? 8 : 4;
      if (name.includes(token)) score += 12;
    }
    return { tool, name, score, index };
  });

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const core = ranked.filter((entry) => CORE_TOOLS.has(entry.name));
  const rest = ranked.filter((entry) => !CORE_TOOLS.has(entry.name));
  const selected = [...core, ...rest].slice(0, limit).map((entry) => entry.tool);
  // Keep original catalog order so prompts and diagnostics remain stable.
  const selectedNames = new Set(selected.map(toolName));
  return catalog.filter((tool) => selectedNames.has(toolName(tool)));
}

module.exports = { CORE_TOOLS, INTENT_HINTS, selectRelevantTools };
