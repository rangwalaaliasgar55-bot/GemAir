"use strict";
/**
 * state-store.ts
 *
 * The concrete, Electron-backed implementation of every read-all/write-all
 * persistence seam `services/maintain/*.ts` defines — the porting spec's
 * `main/maintain/` `MaintainStateStore`. One JSON file, `userData/maintain.json`,
 * in the same "plain JSON, safe to paste into a bug report" spirit as
 * `main/settings.ts`'s `settings.json`: nothing secret ever lives here (no API
 * keys, no GitHub tokens — those stay in `secrets.ts` behind `safeStorage`).
 * This file holds:
 *
 *   - the ask-gate state `incident-coordinator.ts` needs
 *     (`MaintainIncidentGatePersistence`): muted apps, suppressed signature
 *     ids, per-app last-ask timestamps, per-day incident counts.
 *   - the install-provenance records `install-provenance.ts` needs
 *     (`InstallProvenancePersistence`): how each catalog app got onto this
 *     machine, and — for a guide-source clone — where and at what commit.
 *   - the pseudonymous install id `install-identity.ts` needs
 *     (`InstallIdentityPersistence`): a random UUID, rotated every 90 days.
 *
 * Explicitly NOT this file's job: the patch queue (`patch-queue.ts` owns its
 * own per-`(appSlug, recipeId)` JSON file under `userData/patch-queue/`, per
 * that module's own header) and anything secret (`secrets.ts`).
 *
 * One JSON file, one read-modify-write per mutation — matching
 * `SettingsStore`'s shape exactly (read once at construction, rewrite the
 * whole file on every `set`). Maintain-mode writes are rare (an ask raised
 * roughly once a day per app, at most) so there is no contention this needs
 * to be cleverer about.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintainStateStore = void 0;
const electron_1 = require("electron");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const incident_coordinator_1 = require("../../services/maintain/incident-coordinator");
const EMPTY_STATE = {
    gate: incident_coordinator_1.EMPTY_MAINTAIN_INCIDENT_GATE_STATE,
    provenanceByAppSlug: {},
    installIdentity: null,
};
function maintainStateFilePath() {
    const userDataPath = electron_1.app.isReady() ? electron_1.app.getPath("userData") : path.join(process.env.APPDATA || process.env.HOME || ".", "gemair");
    return path.join(userDataPath, "maintain.json");
}
/**
 * The one file-backed store behind all three seams above. Constructed once,
 * at the same point `SettingsStore`/`AccountSession` are constructed in
 * `main/index.ts`'s `app.whenReady()` handler, and passed down to
 * `main/maintain/controller.ts`.
 */
class MaintainStateStore {
    data;
    filePath;
    constructor() {
        this.filePath = maintainStateFilePath();
        this.data = this.readFromDisk();
    }
    // MARK: - MaintainIncidentGatePersistence
    readGateState() {
        return this.data.gate;
    }
    writeGateState(state) {
        this.data = { ...this.data, gate: state };
        this.writeToDisk();
    }
    // MARK: - InstallProvenancePersistence
    readAllProvenanceRecords() {
        return this.data.provenanceByAppSlug;
    }
    writeAllProvenanceRecords(records) {
        this.data = { ...this.data, provenanceByAppSlug: records };
        this.writeToDisk();
    }
    // MARK: - InstallIdentityPersistence
    readCurrentInstallIdentity() {
        return this.data.installIdentity;
    }
    writeCurrentInstallIdentity(record) {
        this.data = { ...this.data, installIdentity: record };
        this.writeToDisk();
    }
    // MARK: - Disk I/O
    readFromDisk() {
        try {
            if (!fs.existsSync(this.filePath))
                return EMPTY_STATE;
            const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            return {
                gate: raw.gate ?? EMPTY_STATE.gate,
                provenanceByAppSlug: raw.provenanceByAppSlug ?? EMPTY_STATE.provenanceByAppSlug,
                installIdentity: raw.installIdentity ?? EMPTY_STATE.installIdentity,
            };
        }
        catch {
            // A corrupt maintain.json is treated as an empty one: the app re-learns
            // the ask gate and provenance from scratch, which is recoverable and
            // never worth crashing over.
            return EMPTY_STATE;
        }
    }
    writeToDisk() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        }
        catch {
            // Silent fail on write error, matching `SettingsStore.save()` — a
            // maintain-state write is never worth crashing the app over.
        }
    }
}
exports.MaintainStateStore = MaintainStateStore;
