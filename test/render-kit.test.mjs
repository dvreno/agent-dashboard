import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asciiToLevels, assetMessages, CODEC_LZ4, CODEC_RAW, encodeTilePayload, fnv1a, lz4CompressBlock,
  lz4DecompressBlock, packGray4, rgbaToLevels, TileDiffer, unpackGray4,
} from '../phone/lib/hud-render-kit.js';

function random(seed) {
  let s = seed;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 16; };
}

test('green channel only, 4 bits, alpha against black', () => {
  const rgba = Uint8Array.from([
    255, 0, 255, 255,  // magenta: no green -> 0
    0, 255, 0, 255,    // green -> 15
    0, 136, 0, 255,    // mid green -> 8
    0, 255, 0, 0,      // fully transparent -> 0
  ]);
  assert.deepEqual([...rgbaToLevels(rgba, 4, 1)], [0, 15, 8, 0]);
});

test('GRAY_4 packing puts even x in the high nibble', () => {
  const packed = packGray4(Uint8Array.from([1, 2, 15, 0]), 4, 1);
  assert.deepEqual([...packed], [0x12, 0xf0]);
  assert.deepEqual([...unpackGray4(packed, 4, 1)], [1, 2, 15, 0]);
  assert.throws(() => packGray4(new Uint8Array(3), 3, 1), /even/);
});

test('FNV-1a matches the C reference values', () => {
  assert.equal(fnv1a(new Uint8Array(0)), 0x811c9dc5);
  assert.equal(fnv1a(new TextEncoder().encode('a')), 0xe40c292c);
  assert.equal(fnv1a(new TextEncoder().encode('foobar')), 0xbf9cf968);
});

test('LZ4 block round trip on varied data', () => {
  const next = random(7);
  const cases = [
    new Uint8Array(0),
    Uint8Array.from([1, 2, 3]),
    new Uint8Array(105_000),                                     // blank full frame
    Uint8Array.from({ length: 5000 }, (_, i) => (i % 37) & 255),  // repeating
    Uint8Array.from({ length: 4096 }, () => next() & 255),        // incompressible
    Uint8Array.from({ length: 70_000 }, (_, i) => (i < 300 ? i & 255 : (i % 300) & 255)), // long matches
  ];
  for (const raw of cases) {
    const packed = lz4CompressBlock(raw);
    assert.deepEqual(lz4DecompressBlock(packed, raw.length), raw);
  }
  assert.ok(lz4CompressBlock(new Uint8Array(105_000)).length < 600, 'a blank frame compresses to almost nothing');
});

test('tile payload falls back to raw when LZ4 does not help', () => {
  const next = random(3);
  const noise = Uint8Array.from({ length: 200 }, () => next() & 255);
  assert.equal(encodeTilePayload(noise).codec, CODEC_RAW);
  assert.equal(encodeTilePayload(new Uint8Array(200)).codec, CODEC_LZ4);
});

test('TileDiffer resends only tiles that changed', () => {
  const differ = new TileDiffer({ width: 600, height: 350, tileWidth: 120, tileHeight: 50 });
  const frame = new Uint8Array(600 * 350);
  const first = differ.diff(frame);
  assert.equal(first.length, 5 * 7, 'everything goes out the first time');
  assert.equal(differ.diff(frame).length, 0, 'nothing changed, nothing sent');
  frame[60 * 600 + 130] = 15;  // one pixel in tile (120, 50)
  const second = differ.diff(frame);
  assert.equal(second.length, 1);
  const view = new DataView(second[0].buffer);
  assert.deepEqual([view.getUint16(2, true), view.getUint16(4, true)], [120, 50]);
  const total = first.reduce((n, m) => n + m.length, 0);
  assert.ok(total < 3000, `a blank 600x350 frame costs ${total} bytes, not 105000`);
});

test('assets are split into tiles with a hash of the packed pixels', () => {
  const { levels, width, height } = asciiToLevels(['#.', '.#', '+-', '00']);
  const { hash, begin, tiles } = assetMessages({ slot: 3, levels, width, height, tileRows: 3 });
  assert.equal(tiles.length, 2);
  const view = new DataView(begin.buffer);
  assert.deepEqual([begin[0], view.getUint16(2, true), view.getUint16(4, true), view.getUint16(6, true)], [3, 2, 4, 3]);
  assert.equal(view.getUint32(8, true), hash);
  assert.equal(hash, fnv1a(packGray4(levels, 2, 4)));
});
