"use strict";
/**
 * lib/iris/integration.js
 *
 * The one file GemAir's `main.js` has to know about.
 *
 * Everything under `lib/iris/` is a port of Blueturboguy07/iris — a whole tray
 * app in its own right, with its own windows, IPC surface, settings store and
 * background watchers. Mounting it by hand would mean a hundred lines in an
 * already-large `main.js`, and any mistake there is a crash on launch of the
 * WHOLE app, not just Assist. So the mount is one call that cannot throw:
 *
 *     const assist = require("./lib/iris/integration").mount({ ... });
 *
 * If anything inside fails to load — a missing module, a bad settings file, a
 * platform API that is not there — `mount()` logs it and returns a stub whose
 * every method is a no-op, and GemAir carries on without Assist. A subsystem
 * that takes the host down with it is worse than one that is absent.
 */

const NOT_MOUNTED = Object.freeze({
  available: false,
  reason: "not mounted",
  openChat() {},
  openGuide() {},
  openGuideFor() {},
  openSettings() {},
  openAutopilot() {},
  receiveDeepLinksFromArgv() {},
  receiveDeepLink() {},
  menuItems: () => [],
  trayTooltip: () => null,
  ask: async () => {
    throw new Error("GemAir Assist is not available in this build.");
  },
  route: () => null,
  refreshRoute: async () => null,
  guides: () => [],
  stop() {},
});

/** True when a `gemair://` link is somewhere in this argv. */
function argvCarriesDeepLink(argv) {
  return (argv || []).some((argument) => String(argument).startsWith("gemair://"));
}

/**
 * Starts the Assist subsystem and hands back its API.
 *
 * @param {object} [options]
 * @param {(items: Array<object>) => void} [options.onTrayChanged] Called when
 *        the Assist tray fragment changed and the host should rebuild its menu.
 * @param {(route: object|null) => void} [options.onRouteChanged] Called when
 *        which free model route is answering changed.
 * @param {boolean} [options.showChat] Open the Assist chat window at startup.
 * @param {boolean} [options.startDetection] Force maintain mode's watchers on
 *        or off, overriding the `maintainEnabled` setting.
 * @returns {object} The Assist API, or an inert stub if it could not start.
 */
function mount(options = {}) {
  let startAssist;
  try {
    ({ startAssist } = require("./main/index"));
  } catch (error) {
    console.error("[assist] could not load:", error && error.message ? error.message : error);
    return { ...NOT_MOUNTED, reason: String((error && error.message) || error) };
  }

  let api;
  try {
    api = startAssist(options);
  } catch (error) {
    console.error("[assist] could not start:", error && error.message ? error.message : error);
    return { ...NOT_MOUNTED, reason: String((error && error.message) || error) };
  }

  // Every method is wrapped, because the host calls these from tray clicks and
  // IPC handlers where an exception is an unhandled rejection at best.
  const guard = (name, fallback) => (...args) => {
    try {
      return api[name](...args);
    } catch (error) {
      console.error(`[assist] ${name} failed:`, error && error.message ? error.message : error);
      return typeof fallback === "function" ? fallback() : fallback;
    }
  };

  return {
    available: true,
    reason: null,
    openChat: guard("openChat"),
    openGuide: guard("openGuide"),
    openGuideFor: guard("openGuideFor"),
    openSettings: guard("openSettings"),
    openAutopilot: guard("openAutopilot"),
    receiveDeepLinksFromArgv: guard("receiveDeepLinksFromArgv"),
    receiveDeepLink: guard("receiveDeepLink"),
    menuItems: guard("menuItems", () => []),
    trayTooltip: guard("trayTooltip", () => null),
    ask: (text) => api.ask(text),
    route: guard("route", () => null),
    refreshRoute: () => api.refreshRoute(),
    guides: guard("guides", () => []),
    showInstalledNotice: guard("showInstalledNotice"),
    stop: guard("stop"),
    /** Escape hatch for anything the host needs that is not wrapped above. */
    raw: () => api,
  };
}

exports.mount = mount;
exports.argvCarriesDeepLink = argvCarriesDeepLink;
exports.NOT_MOUNTED = NOT_MOUNTED;
