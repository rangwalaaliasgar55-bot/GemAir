"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("./vitest-shim");
const app_inventory_1 = require("../../lib/iris/services/maintain/app-inventory");
/**
 * The Windows composition of macOS's AppInventoryService + matchCatalogApp:
 * who's installed, what stack a slug is on, and who's frontmost. Every real I/O
 * seam (catalog fetch, foreground read, installed-path check) is injected, so
 * the whole file is exercised on a Mac and on windows-latest alike.
 */
(0, vitest_1.describe)("the slug → stack dict (copied from macOS)", () => {
    (0, vitest_1.it)("carries every catalog app's stack, defaulting unknowns to other", () => {
        (0, vitest_1.expect)(app_inventory_1.CATALOG_APP_STACKS_BY_SLUG.vscode).toBe("electron");
                (0, vitest_1.expect)(app_inventory_1.CATALOG_APP_STACKS_BY_SLUG.ollama).toBe("other");
        (0, vitest_1.expect)(app_inventory_1.CATALOG_APP_STACKS_BY_SLUG.excalidraw).toBe("other");
        (0, vitest_1.expect)((0, app_inventory_1.stackForSlug)("vscode")).toBe("electron");
        (0, vitest_1.expect)((0, app_inventory_1.stackForSlug)("not-a-catalog-app")).toBe("other");
    });
});
(0, vitest_1.describe)("exe → slug matching", () => {
    (0, vitest_1.it)("resolves the Ollama exe to its slug, case-insensitively and with or without .exe", () => {
        (0, vitest_1.expect)((0, app_inventory_1.slugForProcessName)("ollama app.exe")).toBe("ollama");
        (0, vitest_1.expect)((0, app_inventory_1.slugForProcessName)("OLLAMA APP.EXE")).toBe("ollama");
        (0, vitest_1.expect)((0, app_inventory_1.slugForProcessName)("ollama app")).toBe("ollama");
    });
    (0, vitest_1.it)("returns undefined for anything not in the reviewed Windows roster", () => {
        (0, vitest_1.expect)((0, app_inventory_1.slugForProcessName)("notepad.exe")).toBeUndefined();
        (0, vitest_1.expect)((0, app_inventory_1.slugForProcessName)("ollama.exe")).toBeUndefined(); // the catalog name, not the exe name
        (0, vitest_1.expect)((0, app_inventory_1.slugForProcessName)("")).toBeUndefined();
    });
    (0, vitest_1.it)("exposes the reviewed roster with a real, verified Ollama entry", () => {
        const ollama = (0, app_inventory_1.windowsCatalogAppForSlug)("ollama");
        (0, vitest_1.expect)(ollama?.exeName).toBe("ollama app.exe");
        (0, vitest_1.expect)(ollama?.stack).toBe("other");
        (0, vitest_1.expect)(ollama?.installedExePathTemplate).toContain("%LOCALAPPDATA%");
        (0, vitest_1.expect)(app_inventory_1.WINDOWS_CATALOG_APPS.every((app) => app.exeName.endsWith(".exe"))).toBe(true);
    });
});
(0, vitest_1.describe)("expandWindowsEnvironmentTokens", () => {
    (0, vitest_1.it)("expands known %VAR% tokens against the supplied environment", () => {
        (0, vitest_1.expect)((0, app_inventory_1.expandWindowsEnvironmentTokens)("%LOCALAPPDATA%\\Ollama\\ollama app.exe", {
            LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        })).toBe("C:\\Users\\test\\AppData\\Local\\Ollama\\ollama app.exe");
    });
    (0, vitest_1.it)("leaves an unknown token in place rather than blanking the path", () => {
        (0, vitest_1.expect)((0, app_inventory_1.expandWindowsEnvironmentTokens)("%NOPE%\\x", {})).toBe("%NOPE%\\x");
    });
});
(0, vitest_1.describe)("KnownPathInstalledCatalogAppResolver", () => {
    const ollama = (0, app_inventory_1.windowsCatalogAppForSlug)("ollama");
    const tempDirs = [];
    (0, vitest_1.afterEach)(() => {
        for (const dir of tempDirs.splice(0))
            (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("reports installed when the known exe path exists on disk", () => {
        // Point %APPBASE% at a real temp dir and drop a file where the template
        // resolves — proving the existence check without a real Windows install.
        // Uses a single-segment template so `join` behaves the same on any host.
        const tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-installed-"));
        tempDirs.push(tempDir);
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(tempDir, "ollama app.exe"), "");
        const resolver = new app_inventory_1.KnownPathInstalledCatalogAppResolver({ APPBASE: tempDir });
        const app = {
            ...ollama,
            installedExePathTemplate: (0, node_path_1.join)("%APPBASE%", "ollama app.exe"),
        };
        (0, vitest_1.expect)(resolver.isInstalled(app)).toBe(true);
    });
    (0, vitest_1.it)("reports not installed when the path does not exist", () => {
        const resolver = new app_inventory_1.KnownPathInstalledCatalogAppResolver({ LOCALAPPDATA: (0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-nope-does-not-exist") });
        (0, vitest_1.expect)(resolver.isInstalled(ollama)).toBe(false);
    });
});
(0, vitest_1.describe)("the foreground-process one-liner", () => {
    (0, vitest_1.it)("builds a GetForegroundWindow P/Invoke that prints pid|exe", () => {
        const command = (0, app_inventory_1.buildForegroundProcessCommand)();
        (0, vitest_1.expect)(command).toContain("GetForegroundWindow");
        (0, vitest_1.expect)(command).toContain("GetWindowThreadProcessId");
        (0, vitest_1.expect)(command).toContain("Get-Process");
    });
    (0, vitest_1.it)("parses a well-formed pid|processName line", () => {
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("4821|ollama app.exe\r\n")).toEqual({
            pid: 4821,
            processName: "ollama app.exe",
        });
    });
    (0, vitest_1.it)("takes the last non-empty line, ignoring noise before it", () => {
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("warning: something\n\n77|notepad.exe\n")).toEqual({
            pid: 77,
            processName: "notepad.exe",
        });
    });
    (0, vitest_1.it)("returns undefined for empty output, a non-integer pid, or a missing separator", () => {
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("")).toBeUndefined();
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("\n \n")).toBeUndefined();
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("abc|x.exe")).toBeUndefined();
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("0|x.exe")).toBeUndefined();
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("4821")).toBeUndefined();
        (0, vitest_1.expect)((0, app_inventory_1.parseForegroundProcessOutput)("4821|")).toBeUndefined();
    });
});
/** A scripted `SpawnedProcessLike` that emits `stdout`, then closes — enough to
 *  drive `readForegroundProcessViaPowerShell` without a real process. */
class FakeSpawnedProcess {
    stdoutText;
    emit;
    stdout;
    closeListener;
    killed = false;
    constructor(stdoutText, emit = true) {
        this.stdoutText = stdoutText;
        this.emit = emit;
        this.stdout = {
            on: (_event, listener) => {
                if (this.emit && this.stdoutText.length > 0)
                    listener(this.stdoutText);
            },
        };
    }
    on(event, listener) {
        if (event === "close")
            this.closeListener = listener;
    }
    fireClose() {
        this.closeListener?.(0);
    }
    kill() {
        this.killed = true;
    }
}
(0, vitest_1.describe)("readForegroundProcessViaPowerShell (with an injected spawn)", () => {
    (0, vitest_1.it)("resolves the parsed foreground process from the fake child's stdout", async () => {
        let child;
        const promise = (0, app_inventory_1.readForegroundProcessViaPowerShell)({
            spawnPowerShellOneLiner: () => {
                child = new FakeSpawnedProcess("4821|ollama app.exe\n");
                return child;
            },
        });
        child?.fireClose();
        await (0, vitest_1.expect)(promise).resolves.toEqual({ pid: 4821, processName: "ollama app.exe" });
    });
    (0, vitest_1.it)("resolves undefined when a spawn throws (no powershell.exe on this host)", async () => {
        await (0, vitest_1.expect)((0, app_inventory_1.readForegroundProcessViaPowerShell)({
            spawnPowerShellOneLiner: () => {
                throw new Error("ENOENT powershell.exe");
            },
        })).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("times out to undefined and kills the child", async () => {
        vitest_1.vi.useFakeTimers();
        try {
            let child;
            const promise = (0, app_inventory_1.readForegroundProcessViaPowerShell)({
                timeoutMs: 10,
                spawnPowerShellOneLiner: () => {
                    child = new FakeSpawnedProcess("", false); // never emits, never closes
                    return child;
                },
            });
            await vitest_1.vi.advanceTimersByTimeAsync(11);
            await (0, vitest_1.expect)(promise).resolves.toBeUndefined();
            (0, vitest_1.expect)(child?.killed).toBe(true);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
});
(0, vitest_1.describe)("fetchCatalogApps (injected fetch)", () => {
    const okFetch = (body) => vitest_1.vi.fn(async () => ({ ok: true, status: 200, text: async () => body }));
    (0, vitest_1.it)("serves the bundled roster offline when no catalog is configured, fetching nothing", async () => {
        // The GemAir divergence: upstream always asked publik for the catalog, so
        // an offline machine had none. GemAir's catalogue ships inside the app.
        const fetchImplementation = okFetch("{}");
        const apps = await (0, app_inventory_1.fetchCatalogApps)({ fetchImplementation });
        (0, vitest_1.expect)(fetchImplementation).not.toHaveBeenCalled();
        (0, vitest_1.expect)(apps.map((app) => app.slug)).toEqual(app_inventory_1.WINDOWS_CATALOG_APPS.map((app) => app.slug));
    });
    (0, vitest_1.it)("parses the apps array from a 200 body of a self-hosted catalog", async () => {
        const apps = await (0, app_inventory_1.fetchCatalogApps)({
            catalogBaseUrl: "https://example.test",
            fetchImplementation: okFetch(JSON.stringify({ apps: [{ slug: "cue", name: "Cue", macBundleId: null, latestReleaseTag: null }] })),
        });
        (0, vitest_1.expect)(apps).toEqual([{ slug: "cue", name: "Cue", macBundleId: null, latestReleaseTag: null }]);
    });
    (0, vitest_1.it)("hits {base}/api/gemair/apps with a GET", async () => {
        const fetchImplementation = okFetch(JSON.stringify({ apps: [] }));
        await (0, app_inventory_1.fetchCatalogApps)({ publikBaseUrl: "https://example.test", fetchImplementation });
        (0, vitest_1.expect)(fetchImplementation).toHaveBeenCalledWith("https://example.test/api/gemair/apps", {
            method: "GET",
            headers: { Accept: "application/json" },
        });
    });
    (0, vitest_1.it)("returns an empty list on a non-ok status, a throw, or malformed JSON — never throws", async () => {
        const catalogBaseUrl = "https://example.test";
        await (0, vitest_1.expect)((0, app_inventory_1.fetchCatalogApps)({ catalogBaseUrl, fetchImplementation: vitest_1.vi.fn(async () => ({ ok: false, status: 503, text: async () => "" })) })).resolves.toEqual([]);
        await (0, vitest_1.expect)((0, app_inventory_1.fetchCatalogApps)({
            catalogBaseUrl,
            fetchImplementation: vitest_1.vi.fn(async () => {
                throw new Error("network down");
            }),
        })).resolves.toEqual([]);
        await (0, vitest_1.expect)((0, app_inventory_1.fetchCatalogApps)({ catalogBaseUrl, fetchImplementation: okFetch("not json at all") })).resolves.toEqual([]);
    });
});
/** An installed resolver that says exactly the given slugs are present. */
function fakeInstalledResolver(installedSlugs) {
    return { isInstalled: (app) => installedSlugs.includes(app.slug) };
}
(0, vitest_1.describe)("WindowsAppInventory", () => {
    (0, vitest_1.it)("matches a crashed Ollama exe to its slug + stack (the CrashArtifactAppMatching seam)", () => {
        const inventory = new app_inventory_1.WindowsAppInventory();
        (0, vitest_1.expect)(inventory.catalogApp("ollama app.exe")).toEqual({ slug: "ollama", stack: "other" });
        (0, vitest_1.expect)(inventory.catalogApp("notepad.exe")).toBeUndefined();
    });
    (0, vitest_1.it)("resolves the frontmost catalog app, carrying the pid the hang probe needs", async () => {
        const foreground = { pid: 4821, processName: "ollama app.exe" };
        const inventory = new app_inventory_1.WindowsAppInventory({ readForegroundProcess: async () => foreground });
        await (0, vitest_1.expect)(inventory.frontmostCatalogApp()).resolves.toEqual({
            slug: "ollama",
            appName: "Ollama",
            pid: 4821,
            stack: "other",
        });
    });
    (0, vitest_1.it)("returns no frontmost catalog app when what's in front is not one of ours, or cannot be read", async () => {
        await (0, vitest_1.expect)(new app_inventory_1.WindowsAppInventory({ readForegroundProcess: async () => ({ pid: 10, processName: "notepad.exe" }) }).frontmostCatalogApp()).resolves.toBeUndefined();
        await (0, vitest_1.expect)(new app_inventory_1.WindowsAppInventory({ readForegroundProcess: async () => undefined }).frontmostCatalogApp()).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("reports the installed roster from the installed-resolution seam", () => {
        const installed = new app_inventory_1.WindowsAppInventory({ installedResolver: fakeInstalledResolver(["ollama"]) });
        (0, vitest_1.expect)(installed.installedCatalogSlugs()).toEqual(new Set(["ollama"]));
        (0, vitest_1.expect)(installed.isInstalled("ollama")).toBe(true);
        const none = new app_inventory_1.WindowsAppInventory({ installedResolver: fakeInstalledResolver([]) });
        (0, vitest_1.expect)(none.installedCatalogSlugs().size).toBe(0);
        (0, vitest_1.expect)(none.isInstalled("ollama")).toBe(false);
        (0, vitest_1.expect)(none.isInstalled("not-a-catalog-app")).toBe(false);
    });
    (0, vitest_1.it)("prefers a fetched catalog display name after refreshCatalog, falling back to the roster otherwise", async () => {
        const inventory = new app_inventory_1.WindowsAppInventory({
            fetchCatalogApps: async () => [{ slug: "ollama", name: "Ollama Desktop", macBundleId: null, latestReleaseTag: "v0.1.0" }],
        });
        (0, vitest_1.expect)(inventory.appNameForSlug("ollama")).toBe("Ollama"); // roster fallback before refresh
        await inventory.refreshCatalog();
        (0, vitest_1.expect)(inventory.appNameForSlug("ollama")).toBe("Ollama Desktop");
        (0, vitest_1.expect)(inventory.appNameForSlug("unknown-slug")).toBe("unknown-slug");
    });
});
