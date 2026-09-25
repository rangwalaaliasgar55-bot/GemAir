"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const friendly_label_1 = require("../../lib/iris/services/autopilot/friendly-label");
/**
 * The plain-English line the autopilot terminal shows above each running command.
 * The behaviour under test here is the interactive-installer cue (finding: a
 * freshly-built GUI installer wizard, launched by `Start-Process … -Wait`, ran as
 * a silent `command` step with no cue that a window was waiting on the reader).
 */
(0, vitest_1.describe)("commandLaunchesAGuiInstaller", () => {
    (0, vitest_1.it)("recognises the shared `install-app` wizard shape (Start-Process … -Wait on a setup exe)", () => {
        const command = "$setup = Get-ChildItem src-tauri\\target\\release\\bundle\\nsis -Filter *-setup.exe | Select-Object -First 1\n" +
            "Start-Process -FilePath $setup.FullName -Wait";
        (0, vitest_1.expect)((0, friendly_label_1.commandLaunchesAGuiInstaller)(command)).toBe(true);
    });
    (0, vitest_1.it)("recognises a hardcoded installer path with -Wait", () => {
        (0, vitest_1.expect)((0, friendly_label_1.commandLaunchesAGuiInstaller)('Start-Process -FilePath "C:\\Users\\me\\Downloads\\Foo-setup.exe" -Wait')).toBe(true);
    });
    (0, vitest_1.it)("does NOT flag a fire-and-forget launch (Start-Process with no -Wait) — that is the app opening, not a wizard", () => {
        (0, vitest_1.expect)((0, friendly_label_1.commandLaunchesAGuiInstaller)('Start-Process "$env:LOCALAPPDATA\\PlantGPT\\PlantGPT.exe"')).toBe(false);
    });
    (0, vitest_1.it)("does NOT flag ordinary commands", () => {
        (0, vitest_1.expect)((0, friendly_label_1.commandLaunchesAGuiInstaller)("npm.cmd install")).toBe(false);
        (0, vitest_1.expect)((0, friendly_label_1.commandLaunchesAGuiInstaller)("git clone https://github.com/x/y.git")).toBe(false);
        (0, vitest_1.expect)((0, friendly_label_1.commandLaunchesAGuiInstaller)("winget install --id Foo.Bar -e")).toBe(false);
    });
});
(0, vitest_1.describe)("friendlyLabel for an interactive installer", () => {
    (0, vitest_1.it)("asks the reader to click through the window rather than narrating silently", () => {
        const command = "$setup = Get-ChildItem .\\nsis -Filter *-setup.exe | Select-Object -First 1\n" +
            "Start-Process -FilePath $setup.FullName -Wait";
        const label = (0, friendly_label_1.friendlyLabel)(command);
        (0, vitest_1.expect)(label).toMatch(/installer window/i);
        (0, vitest_1.expect)(label).toMatch(/click through/i);
        // It must NOT fall through to the generic catch-all that gives no cue.
        (0, vitest_1.expect)(label).not.toBe("Running a setup step…");
    });
    (0, vitest_1.it)("still labels ordinary commands as before", () => {
        (0, vitest_1.expect)((0, friendly_label_1.friendlyLabel)("git clone https://github.com/x/y.git")).toBe("Getting the app's code…");
        (0, vitest_1.expect)((0, friendly_label_1.friendlyLabel)("npm install")).toBe("Installing the pieces it needs…");
    });
});
