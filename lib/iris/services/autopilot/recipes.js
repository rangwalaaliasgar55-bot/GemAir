"use strict";
//
// The built-in install recipes. Ported from
// `iris-windows/src/services/autopilot/recipes.ts`, with upstream's catalogue
// (its own company's apps) replaced by tools a GemAir reader actually wants —
// and, for two of them, tools GemAir itself runs on.
//
// A new app is a new entry here: reviewed, version-pinned data, which is the
// provenance the risk gate in `risk.js` leans on. Recipes are plain data so the
// same runner drives every app and the risk suite can assert over them.
//
// Where a bundled guide (`lib/iris/guides/*.json`) covers the same slug, the
// guide wins: `guide-recipe-resolver.js` derives a recipe from the guide and
// only falls back to these when there is no guide branch for this platform.
// These stay because a derived recipe cannot exist offline for an app whose
// guide was never written, and because the resolver's fallback path is the one
// that must never be empty.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.builtinRecipes = builtinRecipes;
exports.recipeForSlug = recipeForSlug;

// ---------------------------------------------------------------------------
// Ollama — a local model runtime. The reason it is first: it is the one install
// that makes GemAir work with no network at all, so the autopilot's own
// usefulness improves when this recipe succeeds.
// ---------------------------------------------------------------------------
const OLLAMA = {
    slug: "ollama",
    appName: "Ollama",
    output: { type: "desktop_app", launch: { via: "path", path: "%LOCALAPPDATA%\\Programs\\Ollama\\ollama app.exe" } },
    steps: [
        {
            id: "install",
            title: "Install Ollama",
            kind: "command",
            // winget runs the publisher's own signed installer. `--silent` keeps the
            // autopilot hands-off; the accept flags are what stop winget blocking on
            // a first-run agreement prompt nobody is there to answer.
            command: "winget install --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements",
            posixCommand: "brew install --cask ollama",
        },
        {
            id: "verify-cli",
            title: "Check Ollama answers",
            kind: "command",
            command: "ollama --version",
            check: { type: "tool_version", tool: "ollama" },
        },
        {
            id: "pull-model",
            title: "Download a small model",
            kind: "command",
            // ~2 GB, and the only step here that takes real time. Pinned to a size
            // that runs on a laptop with no discrete GPU.
            command: "ollama pull llama3.2:3b",
        },
        {
            id: "smoke-test",
            title: "Say hello to it",
            kind: "verify",
            command: "ollama run llama3.2:3b \"reply with the single word: ready\"",
            verifierLabel: "Check it answered",
            watch: { expect: [{ type: "toolVersion", tool: "ollama" }] },
        },
    ],
};

// ---------------------------------------------------------------------------
// opencode — the CLI GemAir can use as its own brain. Free: the install is an
// npm package, and the provider step points at OpenCode Zen's free model ids.
// ---------------------------------------------------------------------------
const OPENCODE = {
    slug: "opencode",
    appName: "opencode CLI",
    output: { type: "credential" },
    prerequisites: [
        {
            id: "node",
            title: "Node.js 20 or newer",
            tool: "node",
            href: "https://nodejs.org/en/download",
            body: "opencode installs through npm, so Node has to be there first.",
        },
    ],
    steps: [
        {
            id: "check-node",
            title: "Check Node",
            kind: "command",
            command: "node --version",
            check: { type: "tool_version", tool: "node" },
        },
        {
            id: "install",
            title: "Install opencode",
            kind: "command",
            command: "npm.cmd install -g opencode-ai",
            posixCommand: "npm install -g opencode-ai",
        },
        {
            id: "verify-cli",
            title: "Check opencode answers",
            kind: "command",
            command: "opencode --version",
            check: { type: "tool_version", tool: "opencode" },
        },
        {
            id: "pick-provider",
            title: "Pick a free model provider",
            kind: "web",
            href: "https://opencode.ai/docs/zen/",
            // Reader-handled on purpose: a sign-in is the one thing GemAir will not
            // type for somebody. It is also optional — GemAir reaches Zen's free
            // models on its own — so the instruction says so rather than implying a
            // dead end.
            instruction:
                "Run `opencode auth login` in a terminal and choose OpenCode Zen, then a model whose id ends in -free. You can skip this: GemAir uses Zen's free models without it.",
        },
    ],
};

// ---------------------------------------------------------------------------
// Excalidraw — a source-build local-web app. This is the recipe that exercises
// the whole hard path: a git clone, a dependency install, a dev server that
// never exits (`longRunning` + `readyWhen`), and a browser open at the end.
// Because it clones a repo and serves locally, finishing it records a
// `guide_source_clone` provenance — the install maintain mode is permitted to
// patch when it breaks.
// ---------------------------------------------------------------------------
const EXCALIDRAW = {
    slug: "excalidraw",
    appName: "Excalidraw",
    output: { type: "local_web", url: "http://localhost:3000" },
    canonicalRepo: "excalidraw/excalidraw",
    prerequisites: [
        {
            id: "git",
            title: "Git",
            tool: "git",
            href: "https://git-scm.com/downloads",
            body: "The source is a git clone, so Git has to be there first.",
        },
        {
            id: "node",
            title: "Node.js 20 or newer",
            tool: "node",
            href: "https://nodejs.org/en/download",
            body: "Excalidraw builds with Node and Yarn.",
        },
    ],
    steps: [
        // The tool checks are one command each so a missing Node cannot be masked
        // by a passing Git in a combined line.
        { id: "check-git", title: "Check Git", kind: "command", command: "git --version", check: { type: "tool_version", tool: "git" } },
        { id: "check-node", title: "Check Node", kind: "command", command: "node --version", check: { type: "tool_version", tool: "node" } },
        {
            id: "clone",
            title: "Copy Excalidraw to this computer",
            kind: "command",
            // Both variants are idempotent — a re-run must not die on an existing
            // clone — and both end inside the clone, so the folder every later
            // step declares is the folder this step actually leaves the shell in.
            command: "New-Item -ItemType Directory -Force ~/gemair-apps | Out-Null; cd ~/gemair-apps; if (-not (Test-Path excalidraw)) { git clone https://github.com/excalidraw/excalidraw.git }; cd excalidraw",
            posixCommand: "mkdir -p ~/gemair-apps; cd ~/gemair-apps; [ -d excalidraw ] || git clone https://github.com/excalidraw/excalidraw.git; cd excalidraw",
            workingDirectory: "~",
        },
        {
            id: "dependencies",
            title: "Install dependencies",
            kind: "command",
            command: "yarn.cmd install",
            posixCommand: "yarn install",
            workingDirectory: "~/gemair-apps/excalidraw",
            posixWorkingDirectory: "~/gemair-apps/excalidraw",
        },
        {
            id: "run",
            title: "Start Excalidraw",
            kind: "command",
            command: "yarn.cmd start",
            posixCommand: "yarn start",
            workingDirectory: "~/gemair-apps/excalidraw",
            posixWorkingDirectory: "~/gemair-apps/excalidraw",
            longRunning: true,
            // Port-agnostic: the dev server bumps to the next free port when 3000 is
            // taken, so wait for any localhost line rather than a specific port. The
            // actual URL is captured by the runner's served-URL detection.
            readyWhen: "localhost",
        },
        { id: "open", title: "Open Excalidraw", kind: "open", href: "http://localhost:3000" },
    ],
};

// ---------------------------------------------------------------------------
// The everyday tools. Short, winget/brew-shaped, and each one ends in a real
// verification rather than "the installer exited 0".
// ---------------------------------------------------------------------------
function wingetTool(options) {
    return {
        slug: options.slug,
        appName: options.appName,
        output: options.output ?? { type: "none" },
        steps: [
            {
                id: "install",
                title: `Install ${options.appName}`,
                kind: "command",
                command: `winget install --id ${options.wingetId} --silent --accept-package-agreements --accept-source-agreements`,
                posixCommand: options.posixCommand,
            },
            {
                id: "verify",
                title: `Check ${options.appName}`,
                kind: "command",
                command: options.verifyCommand,
                check: { type: "tool_version", tool: options.tool },
            },
        ],
    };
}

const NODEJS = wingetTool({
    slug: "nodejs",
    appName: "Node.js",
    wingetId: "OpenJS.NodeJS.LTS",
    posixCommand: "brew install node",
    verifyCommand: "node --version",
    tool: "node",
});

const GIT = wingetTool({
    slug: "git",
    appName: "Git",
    wingetId: "Git.Git",
    posixCommand: "brew install git",
    verifyCommand: "git --version",
    tool: "git",
});

const PYTHON = wingetTool({
    slug: "python",
    appName: "Python",
    wingetId: "Python.Python.3.12",
    posixCommand: "brew install python@3.12",
    verifyCommand: "python --version",
    tool: "python",
});

const VSCODE = wingetTool({
    slug: "vscode",
    appName: "Visual Studio Code",
    wingetId: "Microsoft.VisualStudioCode",
    posixCommand: "brew install --cask visual-studio-code",
    verifyCommand: "code --version",
    tool: "code",
    output: { type: "desktop_app", launch: { via: "shell", command: "code" } },
});

const BUILTIN_RECIPES = [OLLAMA, OPENCODE, EXCALIDRAW, NODEJS, GIT, PYTHON, VSCODE];

/// Every built-in recipe.
function builtinRecipes() {
    return BUILTIN_RECIPES;
}

/// The recipe for an app slug, if GemAir knows how to install it.
function recipeForSlug(slug) {
    return BUILTIN_RECIPES.find((recipe) => recipe.slug === slug);
}
