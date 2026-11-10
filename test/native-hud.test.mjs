// The phone side (phone/native-link.js) drives the real glasses plugin
// (glasses/agent_hud, compiled for this computer against a fake Host).
// Needs a C compiler and the GlassSDK headers (MEMOMIND_SDK, default ../plugin-open-platform).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CMD, CH_UP, decodeUp, encodeConfig, encodeEntries, encodeStatus,
  NativeLink, wrap,
} from '../phone/native-link.js';
import { encodeFbTile, encodeTilePayload, packGray4 } from '../phone/lib/hud-render-kit.js';
import { buildNativeSim } from '../scripts/build-native-sim.mjs';
import { sdkRoot } from '../scripts/sync-sdk.mjs';
import { GlassesSim } from './native/sim-driver.mjs';
import { createState } from '../phone/screen.js';

const haveSdk = existsSync(resolve(sdkRoot(), 'GlassSDK/include/gm_plugin.h'));
let exe;
let liblz4 = false;

before(() => {
  if (!haveSdk) return;
  ({ exe, liblz4 } = buildNativeSim({ quiet: true }));
});

const skip = haveSdk ? false : 'GlassSDK headers not found (set MEMOMIND_SDK)';

/** A glasses sim plus a NativeLink wired to it, like plugin.js does. */
async function setup() {
  const sim = new GlassesSim(exe);
  const outbox = [];
  const link = new NativeLink({ send: (_channel, bytes) => outbox.push(bytes) });
  const flush = async () => {
    // Phone -> glasses, then glasses -> phone, until both sides are quiet.
    const actions = [];
    for (let round = 0; round < 10; round += 1) {
      const batch = outbox.splice(0);
      for (const bytes of batch) await sim.down(bytes);
      const replies = await sim.sent();
      for (const reply of replies) {
        assert.equal(reply.channel, CH_UP);
        actions.push(...link.onMessage(reply.bytes).actions.map((a) => ({ ...a })));
      }
      if (!batch.length && !replies.length) break;
    }
    return actions;
  };
  assert.deepEqual(await sim.cmd('start'), ['R 0']);
  link.start();
  await flush();
  assert.ok(link.ready, 'glasses answered HELLO');
  return { sim, link, outbox, flush };
}

function events(n, kind = 'tool', from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    kind, project: 'web', session: 's1', title: `Bash`, text: `npm run step-${from + i}`,
  }));
}

test('HELLO, icons over Bluetooth, and a clean exit', { skip }, async () => {
  const { sim, link, flush } = await setup();
  assert.equal(link.hello.width, 600);
  assert.equal(link.hello.height, 350);
  assert.ok(link.hello.rawInput, 'raw HOGP input subscribed');
  const screen = await sim.screen();
  assert.ok(screen.some((i) => i.type === 'image' && i.size === '16x16'), 'state icon arrived as an asset');
  // A second HELLO (e.g. reconnect) must not resend icons the glasses already have.
  const before = link.helloCount;
  await sim.cmd('connect 1');
  const resent = [];
  const original = link.send;
  link.send = (ch, bytes) => { resent.push(bytes[0]); original(ch, bytes); };
  await flush();
  assert.equal(link.helloCount, before + 1);
  assert.ok(!resent.includes(CMD.ASSET_BEGIN), 'no icon resent');
  assert.deepEqual(await sim.cmd('stop'), ['LEAKS 0', 'INPUT 0']);
  await sim.close();
});

test('live feed follows new output; scroll-back pages without Bluetooth', { skip }, async () => {
  const { sim, link, flush } = await setup();
  link.addEvents(events(40));
  await flush();
  let text = await sim.text();
  assert.match(text, /Bash: npm run step-39/, 'newest line visible');
  assert.doesNotMatch(text, /step-0\b/, 'oldest scrolled off');
  assert.match(text, /LIVE/);

  // Button-only reading: a click pages back.
  await sim.cmd('button single');
  assert.deepEqual(await sim.sent().then((m) => m.map((x) => decodeUp(x.bytes).type)), ['input', 'view']);
  text = await sim.text();
  assert.doesNotMatch(text, /step-39/);
  assert.match(text, /lines back/);

  // New output while reading back: the view stays put, a counter grows.
  link.addEvents(events(3, 'tool', 40));
  await flush();
  text = await sim.text();
  assert.doesNotMatch(text, /step-42/);
  assert.match(text, /3 new/);

  // Double click: back to live.
  await sim.cmd('button double');
  text = await sim.text();
  assert.match(text, /step-42/);
  assert.match(text, /LIVE/);
  await sim.close();
});

test('ring: wheel, keys, page keys and touch swipes scroll', { skip }, async () => {
  const { sim, link, flush } = await setup();
  link.addEvents(events(60));
  await flush();
  const top = async () => {
    await sim.sent();
    await sim.cmd('nav up');          // cooked nav still works too
    const view = (await sim.sent()).map((m) => decodeUp(m.bytes)).find((m) => m.type === 'view');
    return view.top;
  };
  const start = await top();
  await sim.cmd('wheel 3');           // 3 notches up (older)
  await sim.cmd('key 54');            // PAGE_UP
  await sim.cmd('key 0 repeat');      // UP held: repeats
  await sim.cmd('touch 49');          // swipe down = page up
  const after = await top();
  const page = 11;                    // visible rows - 1 with the fake 20 px font
  assert.equal(start - after, 3 + page + 1 + page + 1, 'every input moved the view');
  await sim.cmd('key 6');             // HOME -> live
  assert.match(await sim.text(), /LIVE/);
  await sim.close();
});

test('approval: settle time, nod allows, the phone ACK clears the card', { skip }, async () => {
  const { sim, link, flush } = await setup();
  const state = createState();
  state.connection = 'online';
  state.pending = [{ id: 'ask-abc', kind: 'permission', risk: 'normal', title: 'Run command', detail: 'npm run build', project: 'web', expiresAt: Date.now() + 90_000 }];
  link.sync(state, Date.now(), state.pending[0]);
  await flush();
  let text = await sim.text();
  assert.match(text, /Run command/);
  assert.match(text, /NOD allow/);
  assert.match(text, /Approve\? Run command: npm run build/, 'waiting summary');
  assert.match(text, /90s|89s/);

  await sim.cmd('gesture nod');       // too soon: a nod already in progress must not count
  let actions = await flush();
  assert.deepEqual(actions.filter((a) => a.type === 'answer'), []);

  await sim.cmd('time 900');
  await sim.cmd('gesture nod');
  actions = await flush();
  assert.deepEqual(actions.filter((a) => a.type === 'answer'), [{ type: 'answer', id: 'ask-abc', decision: 'allow', via: 'nod' }]);
  assert.match(await sim.text(), /Sending/);

  link.ackAnswer('ask-abc', true);
  state.pending = [];
  link.sync(state, Date.now(), null);
  await flush();
  text = await sim.text();
  assert.doesNotMatch(text, /Run command/);
  assert.match(text, /Sent/);
  await sim.close();
});

test('high risk needs a nod and then the button; shake denies', { skip }, async () => {
  const { sim, link, flush } = await setup();
  const state = createState();
  state.connection = 'online';
  state.pending = [
    { id: 'r1', kind: 'permission', risk: 'high', title: 'Run command', detail: 'rm -rf build', project: 'web', expiresAt: Date.now() + 60_000 },
    { id: 'r2', kind: 'permission', risk: 'normal', title: 'Edit file', detail: 'src/a.js', project: 'web', expiresAt: Date.now() + 60_000 },
  ];
  link.sync(state, Date.now(), state.pending[0]);
  await flush();
  await sim.cmd('time 900');
  let text = await sim.text();
  assert.match(text, /HIGH RISK/);
  assert.match(text, /1\/2/);

  await sim.cmd('button single');     // the button alone never approves
  assert.deepEqual((await flush()).filter((a) => a.type === 'answer'), []);
  await sim.cmd('gesture nod');
  assert.match(await sim.text(), /PRESS BUTTON to confirm/);
  await sim.cmd('time 5200');         // too late: the arming lapses
  await sim.cmd('button single');
  assert.deepEqual((await flush()).filter((a) => a.type === 'answer'), []);
  await sim.cmd('gesture nod');
  await sim.cmd('time 1000');
  await sim.cmd('button single');
  assert.deepEqual((await flush()).filter((a) => a.type === 'answer'), [{ type: 'answer', id: 'r1', decision: 'allow', via: 'nod+button' }]);
  link.ackAnswer('r1', true);
  state.pending = state.pending.slice(1);
  link.sync(state, Date.now(), state.pending[0]);
  await flush();

  await sim.cmd('time 900');
  assert.match(await sim.text(), /Edit file/);
  await sim.cmd('gesture shake');
  assert.deepEqual((await flush()).filter((a) => a.type === 'answer'), [{ type: 'answer', id: 'r2', decision: 'deny', via: 'shake' }]);
  link.ackAnswer('r2', false);        // relay said no (e.g. already answered): card stays, toast
  await flush();
  assert.match(await sim.text(), /Answer failed/);
  await sim.close();
});

test('BACK hides the card to read what led up to it, click returns', { skip }, async () => {
  const { sim, link, flush } = await setup();
  link.addEvents(events(5));
  const state = createState();
  state.connection = 'online';
  state.pending = [{ id: 'q', kind: 'question', risk: 'normal', title: 'Deploy now?', detail: '', project: 'web', expiresAt: Date.now() + 60_000 }];
  link.sync(state, Date.now(), state.pending[0]);
  await flush();
  assert.match(await sim.text(), /NOD yes/);
  await sim.cmd('key 5');             // ring BACK
  let text = await sim.text();
  assert.match(text, /step-4/);
  assert.match(text, /click to return/);
  assert.match(text, /Question: Deploy now\?/, 'the waiting summary stays visible');
  await sim.cmd('time 900');
  await sim.cmd('gesture nod');       // card hidden: a nod does nothing
  assert.deepEqual((await flush()).filter((a) => a.type === 'answer'), []);
  await sim.cmd('button single');
  assert.match(await sim.text(), /Deploy now\?/);
  await sim.close();
});

test('history gaps are repaired with NEED; duplicates are ignored', { skip }, async () => {
  const sim = new GlassesSim(exe);
  await sim.cmd('start');
  await sim.sent();
  await sim.down(encodeEntries(1, [{ kind: 1, text: 'one' }, { kind: 1, text: 'two' }]));
  await sim.down(encodeEntries(2, [{ kind: 1, text: 'two' }]));               // duplicate
  await sim.down(encodeEntries(5, [{ kind: 1, text: 'five' }]));              // gap
  const replies = (await sim.sent()).map((m) => decodeUp(m.bytes));
  assert.deepEqual(replies, [{ type: 'need', fromSeq: 3 }]);
  const text = await sim.text();
  assert.equal(text.match(/two/g).length, 1);
  assert.doesNotMatch(text, /five/);
  await sim.close();
});

test('long output wraps, keeps paragraphs, and old lines fall off a full pool', { skip }, async () => {
  const sim = new GlassesSim(exe);
  await sim.cmd('start');
  const paragraph = 'word '.repeat(300).trim();
  let seq = 1;
  for (let i = 0; i < 40; i += 1) {
    await sim.down(encodeEntries(seq, [{ kind: 3, text: `Finished ${i}\n\n\n${paragraph}` }]));
    seq += 1;
  }
  const lines = (await sim.screen()).filter((i) => i.type === 'label' && i.y >= 62 && i.y < 320);
  assert.ok(lines.every((l) => l.text.length * 10 <= 600 - 36 - 20), 'every line fits the body width');
  await sim.cmd('nav home');
  for (let i = 0; i < 200; i += 1) await sim.cmd('nav page_up');
  const text = await sim.text();
  assert.doesNotMatch(text, /Finished 0\b/, 'oldest entries were dropped when the pool filled');
  assert.match(text, /Finished \d+/);
  assert.deepEqual(await sim.cmd('stop'), ['LEAKS 0', 'INPUT 0']);
  await sim.close();
});

test('status header, offline banner and phone notices', { skip }, async () => {
  const sim = new GlassesSim(exe);
  await sim.cmd('start');
  await sim.down(encodeStatus({ state: 0, sessions: 0, left: 'Claude', right: '14:05', waiting: 'Relay offline - reconnecting' }));
  let text = await sim.text();
  assert.match(text, /Claude - offline/);
  assert.match(text, /14:05/);
  assert.match(text, /Relay offline/);
  await sim.down(encodeStatus({ state: 2, sessions: 2, left: 'Claude · web', right: '14:06  2 sessions', waiting: '' }));
  text = await sim.text();
  assert.match(text, /Claude · web - working/);
  assert.doesNotMatch(text, /Relay offline/);
  await sim.down(wrap(CMD.NOTICE, Uint8Array.from([5, ...new TextEncoder().encode('Hello')])));
  assert.match(await sim.text(), /Hello/);
  await sim.cmd('time 2000');
  assert.doesNotMatch(await sim.text(), /Hello/);
  await sim.close();
});

test('config: keymap overrides, raw input off, head paging off', { skip }, async () => {
  const sim = new GlassesSim(exe);
  await sim.cmd('start');
  await sim.down(encodeEntries(1, Array.from({ length: 30 }, (_, i) => ({ kind: 1, text: `line ${i}` }))));
  await sim.sent();
  // HI_IN_BUTTON_SINGLE (1) -> A_LIVE (8); raw off; no head paging.
  await sim.down(encodeConfig({ raw: false, wheelStep: 2, headPaging: false, keymap: [[1, 8]] }));
  const hello = (await sim.sent()).map((m) => decodeUp(m.bytes)).find((m) => m.type === 'hello');
  assert.equal(hello.rawInput, false, 'raw subscription dropped');
  await sim.cmd('gesture left');
  assert.match(await sim.text(), /LIVE/, 'head turn ignored');
  await sim.cmd('nav up');
  assert.match(await sim.text(), /lines back/);
  await sim.cmd('button single');
  assert.match(await sim.text(), /LIVE/, 'click remapped to live');
  await sim.close();
});

test('suspend releases the ring subscription, resume takes it back', { skip }, async () => {
  const sim = new GlassesSim(exe);
  await sim.cmd('start');
  assert.deepEqual(await sim.cmd('suspend'), ['INPUT 0']);
  assert.deepEqual(await sim.cmd('resume'), ['INPUT 11']);
  await sim.close();
});

test('framebuffer tiles from the phone kit decode with the reference LZ4', { skip }, async () => {
  const sim = new GlassesSim(exe);
  await sim.cmd('start');
  const w = 40;
  const h = 10;
  const levels = Uint8Array.from({ length: w * h }, (_, i) => (i % w) % 16);
  const raw = packGray4(levels, w, h);
  const { codec, payload } = encodeTilePayload(raw);
  assert.equal(codec, 1, 'compressible tile goes out as LZ4');
  await sim.down(wrap(CMD.FB_TILE, encodeFbTile({ codec, x: 100, y: 200, width: w, height: h, rawLength: raw.length, payload })));
  const row = (await sim.cmd('fb 203'))[0].slice(2);
  assert.equal(row.slice(100, 100 + w), Buffer.from(raw.subarray(3 * (w / 2), 4 * (w / 2))).toString('hex'));
  await sim.close();
  if (!liblz4) console.log('# note: built-in LZ4 decoder used (install liblz4 for the reference check)');
});

after(() => GlassesSim.killAll());
