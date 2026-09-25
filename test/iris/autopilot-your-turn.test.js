"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const your_turn_1 = require("../../lib/iris/services/autopilot/your-turn");
/**
 * The tray's "your turn" state, as a pure reducer. The tray itself can't be
 * unit-tested (it imports Electron), so this pins the decision that drives it:
 * WHEN the run is waiting on the reader, and when the one-off toast fires. See
 * `services/autopilot/your-turn.ts`; `src/main/tray.ts` is the thin adaptor.
 */
const stepStarted = { type: "stepStarted", index: 0, total: 3, title: "Clone", kind: "command" };
const commandStarted = { type: "commandStarted", text: "npm ci", friendlyLabel: "Installing…" };
const handedToReader = { type: "handedToReader", instruction: "Sign in here, then GemAir carries on." };
const needsConfirm = { type: "needsConfirm", command: "sudo make install", reason: "This runs as administrator." };
const surfaced = { type: "surfaced", reason: "That command didn't finish cleanly." };
const finished = { type: "finished", output: { type: "local_web", url: "http://localhost:1234" } };
const aborted = { type: "aborted" };
(0, vitest_1.describe)("the your-turn tracker", () => {
    (0, vitest_1.it)("stays quiet while the run is moving on its own", () => {
        const tracker = new your_turn_1.YourTurnTracker();
        for (const event of [stepStarted, commandStarted]) {
            (0, vitest_1.expect)(tracker.observe(event).action).toBe("none");
        }
        (0, vitest_1.expect)(tracker.isWaiting).toBe(false);
    });
    (0, vitest_1.it)("raises (and toasts once) when the run hands off to the reader", () => {
        const tracker = new your_turn_1.YourTurnTracker();
        const update = tracker.observe(handedToReader);
        (0, vitest_1.expect)(update).toEqual({ action: "raise", instruction: handedToReader.instruction, notify: true });
        (0, vitest_1.expect)(tracker.isWaiting).toBe(true);
        (0, vitest_1.expect)(tracker.currentInstruction).toBe(handedToReader.instruction);
    });
    (0, vitest_1.it)("does not re-toast while it is already the reader's turn", () => {
        const tracker = new your_turn_1.YourTurnTracker();
        (0, vitest_1.expect)(tracker.observe(handedToReader)).toMatchObject({ action: "raise", notify: true });
        // A second waiting event (e.g. a follow-up surfaced line) must not re-notify.
        const second = tracker.observe(surfaced);
        (0, vitest_1.expect)(second).toMatchObject({ action: "raise", notify: false });
    });
    (0, vitest_1.it)("clears when the run starts moving again, then can toast anew", () => {
        const tracker = new your_turn_1.YourTurnTracker();
        tracker.observe(needsConfirm);
        (0, vitest_1.expect)(tracker.observe(commandStarted).action).toBe("clear");
        (0, vitest_1.expect)(tracker.isWaiting).toBe(false);
        // A later wait toasts again — it is a fresh transition into waiting.
        (0, vitest_1.expect)(tracker.observe(handedToReader)).toMatchObject({ action: "raise", notify: true });
    });
    (0, vitest_1.it)("treats a confirm reason as the waiting instruction", () => {
        const tracker = new your_turn_1.YourTurnTracker();
        const update = tracker.observe(needsConfirm);
        (0, vitest_1.expect)(update).toMatchObject({ action: "raise", instruction: "This runs as administrator." });
    });
    (0, vitest_1.it)("clears on a finished run and on an aborted run", () => {
        for (const ending of [finished, aborted]) {
            const tracker = new your_turn_1.YourTurnTracker();
            tracker.observe(handedToReader);
            (0, vitest_1.expect)(tracker.observe(ending).action).toBe("clear");
            (0, vitest_1.expect)(tracker.isWaiting).toBe(false);
        }
    });
    (0, vitest_1.it)("reports no change when a moving event arrives and nothing was waiting", () => {
        const tracker = new your_turn_1.YourTurnTracker();
        (0, vitest_1.expect)(tracker.observe(finished).action).toBe("none");
    });
});
