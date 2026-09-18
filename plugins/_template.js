'use strict';
/* ============================================================
   GemAir plugin starter — COPY THIS FILE to write a new skill.

   A plugin is ONE file dropped into this plugins/ folder. On the
   next launch (or after pressing "Reload plugins" in Settings →
   Plugins) Gem learns the new skill automatically: the PLUGIN
   declaration is merged into the tool catalog the AI model sees,
   and run() is dispatched by GemAir's permission-gated executor.

   This file is named with a leading underscore, so the loader
   skips it — it is documentation, not a live skill. Your copy
   should be named something like `my-skill.js`.

   Rules of the road:
     • Declare everything the model needs to call you correctly:
       a lowercase snake_case `name`, a plain-language
       `description` (the model picks tools from this text!) and,
       when you take arguments, a JSON Schema `parameters` object.
     • Return plain JSON-serializable values (objects, arrays,
       strings). The result travels back to the model as the tool
       response — keep it short and factual, the model does the
       talking.
     • Throwing is fine: GemAir converts a throw into a clean
       tool error instead of crashing.
     • Choose `risk: 'sensitive'` when your skill changes files,
       system state, or contacts the outside world with
       side-effects. Sensitive tools trigger a human
       confirmation dialog before they run.
     • `context` gives you a deliberately small, safe surface:
       homeDir, platform, app version, the saved user name, and
       notify(title, body) for an OS-native notification.
       Plugins never receive API keys or raw app internals.
     • Keep it local-first: GemAir does not download plugin code;
       prefer skills that respect that posture too.
   ============================================================ */

module.exports = {
  PLUGIN: {
    // Required: 2-50 chars, lowercase letters / digits / underscores,
    // starting with a letter. Must not collide with a built-in tool.
    name: 'my_skill_name',

    // Required: one sentence the AI model reads to decide when this
    // skill is the right one to call. Be concrete about inputs.
    description: 'Describe what this skill does and when to use it.',

    // Optional: JSON Schema for the arguments (object). Omit if your
    // skill needs no arguments.
    parameters: {
      type: 'object',
      properties: {
        example: { type: 'string', description: 'An example argument.' }
      },
      required: ['example']
    },

    // Optional: 'safe' (default, read-only / no side effects) or
    // 'sensitive' (writes files, changes system state — Gem asks the
    // user to confirm before it runs).
    risk: 'safe'
  },

  /**
   * The handler. Receives the model-supplied args (already validated
   * against your JSON Schema by GemAir) and the plugin context.
   * Return a JSON-serializable value, or throw to signal failure.
   */
  async run(args, context) {
    const who = (args && args.example) || context.userName || 'friend';
    return { message: `Hello from your new skill, ${who}!` };
  }
};
