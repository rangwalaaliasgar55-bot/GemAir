/* renderer/audio-devices.js — pick the microphone and the speakers by name.
 *
 * Concept port (no upstream code) of Mark-LIV's audio device picker:
 * choose the hardware yourself instead of trusting the OS "default" (which
 * on Windows moves the moment a headset is plugged in). The list is short —
 * one entry per device, kind-filtered, labelled — and saved picks are
 * resolved against what's actually present: an unplugged device falls back
 * to the system default AND SAYS SO, never a silent lie.
 *
 * Speaker routing honesty (kept in the Settings hint): Edge/file/mp3 audio
 * and the Live playback AudioContext CAN be routed (setSinkId); the OS
 * web-speech voice cannot — Chromium gives us no handle on it.
 *
 * Plain script: window.GemAudioDevices in the renderer; vm/required by tests
 * via the module.exports branch.
 */
(function () {
  'use strict';

  const MAX_PER_KIND = 8; // the OS rarely shows more than this; trim the long tail honestly

  /**
   * One entry per device, kind-filtered, human-labelled.
   * `devices` is the enumerateDevices result; `kind` is 'audioinput'|'audiooutput'.
   * Returns [{ deviceId, label, kind, isDefault }], system default FIRST.
   * Over-long true lists are capped at MAX_PER_KIND.
   */
  function filterDeviceList(devices, kind) {
    const raw = Array.isArray(devices) ? devices : [];
    const list = raw.filter((d) => d && d.kind === kind);
    const seen = new Set();
    const out = [];
    let index = 0;
    for (const d of list) {
      if (seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      index++;
      const isDefault = d.deviceId === 'default';
      // Chromium gives empty labels until mic permission is granted; the
      // caller re-enumerates after prompting, but we still never show ''.
      const base = d.deviceId === 'default' ? 'System default'
        : (String(d.label || '').trim() || (kind === 'audioinput' ? 'Microphone' : 'Speaker') + ' ' + index);
      const label = base.length > 48 ? base.slice(0, 45) + '…' : base;
      out.push({ deviceId: String(d.deviceId), label, kind, isDefault });
      if (out.length >= MAX_PER_KIND) break;
    }
    out.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    return out;
  }

  /**
   * Resolve a saved pick against live devices: { deviceId, fellBack, label }.
   * deviceId '' means "no pick / default". A missing saved device falls back
   * — honestly — to the default and reports fellBack=true with the lost name.
   */
  function resolveSaved(saved, devices, kind) {
    const savedId = saved && saved.deviceId;
    if (!savedId) return { deviceId: '', fellBack: false, label: '' };
    const found = filterDeviceList(devices, kind).find((d) => d.deviceId === savedId);
    if (found) return { deviceId: found.deviceId, fellBack: false, label: found.label };
    return { deviceId: '', fellBack: true, label: String((saved && saved.label) || '').slice(0, 60) };
  }

  /**
   * Enumerate devices; when labels are hidden (no mic permission yet),
   * open the mic ONCE, re-enumerate, and close it. Grant failures report
   * honestly instead of returning an empty, useless list.
   */
  async function listAudioDevices(nav) {
    const media = (nav || (typeof navigator !== 'undefined' ? navigator : null))?.mediaDevices;
    if (!media || !media.enumerateDevices) return { ok: false, error: 'mediaDevices unavailable in this environment.', inputs: [], outputs: [] };
    let devices = await media.enumerateDevices();
    const inputsRaw = filterDeviceList(devices, 'audioinput');
    const needsLabels = inputsRaw.some((d) => !d.isDefault && (d.label.startsWith('Microphone ')));
    if (needsLabels && media.getUserMedia) {
      try {
        const stream = await media.getUserMedia({ audio: true });
        try { devices = await media.enumerateDevices(); } catch {}
        (stream.getTracks ? stream.getTracks() : []).forEach((t) => { try { t.stop(); } catch {} });
      } catch (error) {
        return { ok: false, error: 'Microphone permission needed to list device names (' + (error && error.name || 'denied') + ').', inputs: filterDeviceList(devices, 'audioinput'), outputs: filterDeviceList(devices, 'audiooutput') };
      }
    }
    return { ok: true, inputs: filterDeviceList(devices, 'audioinput'), outputs: filterDeviceList(devices, 'audiooutput') };
  }

  /**
   * Measured pick: actually open the mic (1 short touch), confirm a live
   * audio track, and report — so a listed device is one that WORKS, mirroring
   * Mark's "measured, so every entry actually works". Fails honestly per
   * device; tracks are always released.
   */
  async function probeMic(deviceId, nav) {
    const media = (nav || (typeof navigator !== 'undefined' ? navigator : null))?.mediaDevices;
    if (!media || !media.getUserMedia) return { ok: false, error: 'no getUserMedia' };
    const started = Date.now();
    let stream = null;
    try {
      stream = await media.getUserMedia({
        audio: Object.assign(
          { channelCount: 1, echoCancellation: true },
          deviceId ? { deviceId: { exact: deviceId } } : {})
      });
      const tracks = (stream.getAudioTracks && stream.getAudioTracks()) || [];
      const ok = tracks.length > 0 && tracks.some((t) => t.readyState === 'live');
      if (!ok) return { ok: false, error: 'no live audio track' };
      return { ok: true, latencyMs: Date.now() - started, trackLabel: String(tracks[0].label || '').slice(0, 80) };
    } catch (error) {
      return { ok: false, error: String(error && (error.overconstraintedError || error.message || error.name) || 'open failed') };
    } finally {
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    }
  }

  const api = { filterDeviceList, resolveSaved, listAudioDevices, probeMic, MAX_PER_KIND };
  if (typeof window !== 'undefined') window.GemAudioDevices = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
