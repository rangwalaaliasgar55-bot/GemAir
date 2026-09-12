'use strict';

/*
 * Minimal dependency-free SHA3-512 (Keccak-f[1600], rate 576, suffix 0x06).
 *
 * Why this file exists: Electron ships BoringSSL without SHA-3, so
 * crypto.createHash('sha3-512') throws "Digest method not supported" inside
 * the sidecar — but OpenAI's proof-of-work mandates sha3-512 and no other
 * digest is acceptable. This pure-JS fallback is used ONLY when the native
 * call throws; on runtimes with SHA-3 it is never consulted. Verified against
 * Node's OpenSSL implementation (NIST vectors + randomized cross-checks in
 * test/freegpt35-sidecar.test.js).
 */

const MASK64 = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

// Rotation offsets RHO[x][y]: each row below is one x-column down the y rows.
const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];

function rotl64(value, shift) {
  const n = shift % 64;
  if (n === 0) return value & MASK64;
  return (((value << BigInt(n)) | (value >> BigInt(64 - n))) & MASK64);
}

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const d = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK64;
      }
    }
    // Rho + Pi
    const next = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        next[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], RHO[x][y]);
      }
    }
    // Chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = (next[x + 5 * y] ^ ((~next[(x + 1) % 5 + 5 * y] & MASK64) & next[(x + 2) % 5 + 5 * y])) & MASK64;
      }
    }
    // Iota
    state[0] = (state[0] ^ RC[round]) & MASK64;
  }
}

function utf8Bytes(text) {
  const out = [];
  const str = String(text == null ? '' : text);
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        // Lone high surrogate: Node encodes U+FFFD, so do we.
        out.push(0xef, 0xbf, 0xbd);
        continue;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate: same replacement.
      out.push(0xef, 0xbf, 0xbd);
      continue;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

/** SHA3-512 digest as lowercase hex. Input is UTF-8 encoded like Node does. */
function sha3_512_hex(message) {
  const bytes = utf8Bytes(message);
  const rate = 72; // 576-bit rate for SHA3-512
  // pad10*1 with domain suffix 0x06.
  const paddedLength = (Math.floor(bytes.length / rate) + 1) * rate;
  const padded = new Array(paddedLength).fill(0);
  for (let i = 0; i < bytes.length; i++) padded[i] = bytes[i];
  padded[bytes.length] ^= 0x06;
  padded[paddedLength - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let off = 0; off < paddedLength; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[off + i * 8 + b]) << BigInt(8 * b);
      }
      state[i] ^= lane;
    }
    keccakF(state);
  }
  let hex = '';
  // Squeeze little-endian: lane bytes emerge in the order they went in.
  for (let i = 0; i < 8; i++) {
    let lane = state[i];
    for (let b = 0; b < 8; b++) {
      hex += (lane & 0xffn).toString(16).padStart(2, '0');
      lane >>= 8n;
    }
  }
  return hex;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sha3_512_hex };
}
