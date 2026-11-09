// hud-render-kit: the phone half of hud_render (glasses/lib/hud_render).
//
// MemoMind glasses show 600x350 pixels in 16 levels of green, and Bluetooth is
// the bottleneck (about 200-500 ms per frame). So:
//   - keep only the green channel, at 4 bits per pixel, two pixels per byte
//     (even x in the high nibble): a full frame is 105 000 bytes, not 840 000;
//   - LZ4-compress it (raw LZ4 blocks, what the glasses' LZ4 extension decodes);
//   - send only the tiles whose hash changed since the last frame;
//   - prefer text and shapes drawn on the glasses (LVGL) over bitmaps.
//
// No DOM, no dependencies: works in the MemoMind WebView and in Node tests.

export const GRAY_LEVELS = 16;
export const CODEC_RAW = 0;
export const CODEC_LZ4 = 1;
export const ASSET_TRANSPARENT_ZERO = 0x01;

// ---- pixels --------------------------------------------------------------------

/** RGBA bytes (e.g. canvas ImageData.data) -> one grey level 0..15 per pixel, from green only. */
export function rgbaToLevels(rgba, width, height) {
  const levels = new Uint8Array(width * height);
  for (let i = 0, p = 1; i < levels.length; i += 1, p += 4) {
    // Alpha-premultiply against black, since the HUD background is black.
    const green = (rgba[p] * rgba[p + 2]) / 255;
    levels[i] = Math.round((green * 15) / 255);
  }
  return levels;
}

/** Grey levels -> packed GRAY_4 (two pixels per byte, even x in the high nibble). */
export function packGray4(levels, width, height) {
  if (width % 2 !== 0) throw new Error('GRAY_4 width must be even');
  const packed = new Uint8Array((width / 2) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const i = y * width + x;
      packed[y * (width / 2) + x / 2] = ((levels[i] & 15) << 4) | (levels[i + 1] & 15);
    }
  }
  return packed;
}

/** Packed GRAY_4 -> grey levels (for tests and previews). */
export function unpackGray4(packed, width, height) {
  const levels = new Uint8Array(width * height);
  for (let i = 0; i < levels.length; i += 2) {
    const byte = packed[i / 2];
    levels[i] = byte >> 4;
    levels[i + 1] = byte & 15;
  }
  return levels.subarray(0, width * height);
}

/**
 * ASCII art -> grey levels. Each character is one pixel: ' ' or '.' = 0,
 * '0'-'9' = that level, 'a'-'f' = 10-15, '#' = 15, '+' = 9, '-' = 5.
 */
export function asciiToLevels(rows) {
  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));
  const levels = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const c = row[x];
      let v = 0;
      if (c === '#') v = 15;
      else if (c === '+') v = 9;
      else if (c === '-') v = 5;
      else if (/[0-9]/.test(c)) v = Number(c);
      else if (/[a-f]/.test(c)) v = c.charCodeAt(0) - 87;
      levels[y * width + x] = v;
    }
  });
  return { levels, width, height };
}

/** 32-bit FNV-1a, matching hr_fnv1a() on the glasses. */
export function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---- LZ4 block format --------------------------------------------------------------

const MIN_MATCH = 4;
const MF_LIMIT = 12;      // the last match must start at least 12 bytes before the end
const LAST_LITERALS = 5;  // the last 5 bytes are always literals
const HASH_LOG = 12;

function writeLength(out, length) {
  let rest = length;
  while (rest >= 255) {
    out.push(255);
    rest -= 255;
  }
  out.push(rest);
}

function emitSequence(out, src, literalStart, literalEnd, matchOffset, matchLength) {
  const literals = literalEnd - literalStart;
  const token = (Math.min(literals, 15) << 4) | (matchLength === null ? 0 : Math.min(matchLength - MIN_MATCH, 15));
  out.push(token);
  if (literals >= 15) writeLength(out, literals - 15);
  for (let i = literalStart; i < literalEnd; i += 1) out.push(src[i]);
  if (matchLength === null) return;
  out.push(matchOffset & 255, matchOffset >> 8);
  if (matchLength - MIN_MATCH >= 15) writeLength(out, matchLength - MIN_MATCH - 15);
}

/** Compress one independent raw LZ4 block (no frame header, no size prefix). */
export function lz4CompressBlock(src) {
  const input = src instanceof Uint8Array ? src : new Uint8Array(src);
  const out = [];
  const length = input.length;
  const table = new Int32Array(1 << HASH_LOG).fill(-1);
  let anchor = 0;
  let i = 0;
  const matchLimit = length - LAST_LITERALS;
  const hashAt = (p) => (Math.imul(input[p] | (input[p + 1] << 8) | (input[p + 2] << 16) | (input[p + 3] << 24), 2654435761) >>> (32 - HASH_LOG));
  if (length >= MF_LIMIT + 1) {
    while (i <= length - MF_LIMIT) {
      const h = hashAt(i);
      const candidate = table[h];
      table[h] = i;
      if (candidate >= 0 && i - candidate <= 0xffff &&
          input[candidate] === input[i] && input[candidate + 1] === input[i + 1] &&
          input[candidate + 2] === input[i + 2] && input[candidate + 3] === input[i + 3]) {
        let matchLength = MIN_MATCH;
        while (i + matchLength < matchLimit && input[candidate + matchLength] === input[i + matchLength]) matchLength += 1;
        emitSequence(out, input, anchor, i, i - candidate, matchLength);
        i += matchLength;
        anchor = i;
        if (i <= length - MF_LIMIT) table[hashAt(i - 2)] = i - 2;
      } else {
        i += 1;
      }
    }
  }
  emitSequence(out, input, anchor, length, 0, null);
  return Uint8Array.from(out);
}

/** Decompress one raw LZ4 block of known decompressed size (tests, previews). */
export function lz4DecompressBlock(src, rawLength) {
  const out = new Uint8Array(rawLength);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let literals = token >> 4;
    if (literals === 15) {
      let b;
      do { b = src[ip++]; literals += b; } while (b === 255);
    }
    if (op + literals > rawLength || ip + literals > src.length) throw new Error('lz4: literal overrun');
    out.set(src.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    if (ip >= src.length) break;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('lz4: bad offset');
    let matchLength = token & 15;
    if (matchLength === 15) {
      let b;
      do { b = src[ip++]; matchLength += b; } while (b === 255);
    }
    matchLength += MIN_MATCH;
    if (op + matchLength > rawLength) throw new Error('lz4: match overrun');
    for (let k = 0; k < matchLength; k += 1, op += 1) out[op] = out[op - offset];
  }
  if (op !== rawLength) throw new Error(`lz4: got ${op} bytes, expected ${rawLength}`);
  return out;
}

/** LZ4 when it actually saves bytes, raw otherwise. */
export function encodeTilePayload(raw, { lz4 = true } = {}) {
  if (lz4) {
    const compressed = lz4CompressBlock(raw);
    if (compressed.length < raw.length) return { codec: CODEC_LZ4, payload: compressed };
  }
  return { codec: CODEC_RAW, payload: raw };
}

// ---- wire messages (bodies match glasses/lib/hud_render/hud_render.h) --------------

const u16 = (view, at, v) => view.setUint16(at, v, true);
const u32 = (view, at, v) => view.setUint32(at, v >>> 0, true);

export function encodeAssetBegin({ slot, flags = 0, width, height, tileRows, hash }) {
  const body = new Uint8Array(12);
  const view = new DataView(body.buffer);
  body[0] = slot;
  body[1] = flags;
  u16(view, 2, width);
  u16(view, 4, height);
  u16(view, 6, tileRows);
  u32(view, 8, hash);
  return body;
}

export function encodeAssetTile({ slot, codec, tile, rawLength, payload }) {
  const body = new Uint8Array(6 + payload.length);
  const view = new DataView(body.buffer);
  body[0] = slot;
  body[1] = codec;
  u16(view, 2, tile);
  u16(view, 4, rawLength);
  body.set(payload, 6);
  return body;
}

export function encodeFbTile({ codec, x, y, width, height, rawLength, payload }) {
  const body = new Uint8Array(12 + payload.length);
  const view = new DataView(body.buffer);
  body[0] = codec;
  body[1] = 0;
  u16(view, 2, x);
  u16(view, 4, y);
  u16(view, 6, width);
  u16(view, 8, height);
  u16(view, 10, rawLength);
  body.set(payload, 12);
  return body;
}

/**
 * An asset (icon, logo) for hud_render's asset slots: returns the message
 * bodies [begin, ...tiles] to send after launch. Rows are cut into tiles of
 * tileRows rows so no single Bluetooth message gets large.
 */
export function assetMessages({ slot, levels, width, height, flags = ASSET_TRANSPARENT_ZERO, tileRows = 32, lz4 = true }) {
  const packed = packGray4(levels, width, height);
  const stride = width / 2;
  const hash = fnv1a(packed);
  const begin = encodeAssetBegin({ slot, flags, width, height, tileRows, hash });
  const tiles = [];
  for (let tile = 0, row = 0; row < height; tile += 1, row += tileRows) {
    const raw = packed.subarray(row * stride, Math.min(height, row + tileRows) * stride);
    const { codec, payload } = encodeTilePayload(raw, { lz4 });
    tiles.push(encodeAssetTile({ slot, codec, tile, rawLength: raw.length, payload }));
  }
  return { hash, begin, tiles };
}

/**
 * Tracks what the glasses already have, per frame tile, and returns only the
 * tiles that changed. Tiles are tileWidth x tileHeight (tileWidth even).
 */
export class TileDiffer {
  constructor({ width = 600, height = 350, tileWidth = 120, tileHeight = 50, lz4 = true } = {}) {
    if (tileWidth % 2 !== 0) throw new Error('tileWidth must be even');
    Object.assign(this, { width, height, tileWidth, tileHeight, lz4 });
    this.hashes = new Map();
  }

  /** Forget everything (the glasses restarted or the screen was cleared). */
  reset() {
    this.hashes.clear();
  }

  /** levels: one grey level per pixel for the whole screen. Returns FB_TILE bodies. */
  diff(levels) {
    const messages = [];
    for (let y = 0; y < this.height; y += this.tileHeight) {
      for (let x = 0; x < this.width; x += this.tileWidth) {
        const w = Math.min(this.tileWidth, this.width - x);
        const h = Math.min(this.tileHeight, this.height - y);
        const tile = new Uint8Array(w * h);
        for (let row = 0; row < h; row += 1) {
          tile.set(levels.subarray((y + row) * this.width + x, (y + row) * this.width + x + w), row * w);
        }
        const raw = packGray4(tile, w, h);
        const key = `${x},${y}`;
        const hash = fnv1a(raw);
        if (this.hashes.get(key) === hash) continue;
        this.hashes.set(key, hash);
        const { codec, payload } = encodeTilePayload(raw, { lz4: this.lz4 });
        messages.push(encodeFbTile({ codec, x, y, width: w, height: h, rawLength: raw.length, payload }));
      }
    }
    return messages;
  }
}
