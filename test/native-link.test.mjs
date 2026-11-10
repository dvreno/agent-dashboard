import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CMD, encodeAsk, encodeConfig, eventToEntry, GLASSES_WINDOW, glassesText, KIND, MORE_ON_PHONE, NativeLink, STATE, statusFor, utf8 } from '../phone/native-link.js';
import { createState } from '../phone/screen.js';

function hello(lastSeq, hashes = []) {
  const bytes = new Uint8Array(12 + hashes.length * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x81; bytes[1] = 1;
  view.setUint16(2, 600, true); view.setUint16(4, 350, true);
  bytes[6] = 3; view.setUint32(7, lastSeq, true); bytes[11] = hashes.length;
  hashes.forEach((h, i) => view.setUint32(12 + i * 4, h, true));
  return bytes;
}

function linkWithLog(n) {
  const sent = [];
  const link = new NativeLink({ send: (_ch, bytes) => sent.push(bytes) });
  link.addEvents(Array.from({ length: n }, (_, i) => ({ kind: 'tool', title: 'Bash', text: `step ${i}` })));
  return { link, sent };
}

const firstSeqs = (sent) => sent.filter((b) => b[0] === CMD.ENTRIES).map((b) => new DataView(b.buffer).getUint32(1, true));

test('first HELLO resets the glasses and sends the whole log', () => {
  const { link, sent } = linkWithLog(5);
  assert.equal(sent.length, 0, 'nothing is sent before the glasses answer');
  link.onMessage(hello(0));
  assert.equal(sent[0][0], CMD.RESET);
  assert.deepEqual(firstSeqs(sent), [1]);
});

test('the glasses get only the recent window; the phone keeps everything', () => {
  const { link, sent } = linkWithLog(50);
  link.onMessage(hello(0));
  assert.equal(GLASSES_WINDOW, 12);
  assert.deepEqual(firstSeqs(sent), [50 - GLASSES_WINDOW + 1]);
  assert.equal(link.history().length, 50);
  // Glasses far behind (would leave a gap): start clean with the window.
  sent.length = 0;
  link.onMessage(hello(10, link.hello.assetHashes));
  assert.equal(sent[0][0], CMD.RESET);
  assert.deepEqual(firstSeqs(sent), [39]);
});

test('long text is cut for the glasses and points at the phone', () => {
  const short = 'ok';
  assert.equal(new TextDecoder().decode(glassesText(short)), short);
  const long = '€'.repeat(800);
  const cut = new TextDecoder().decode(glassesText(long));
  assert.ok(new TextEncoder().encode(cut).length <= 1000);
  assert.ok(cut.endsWith(MORE_ON_PHONE));
  assert.ok(!cut.includes('\uFFFD'), 'no split characters');
});

test('raw ring input is opt-in; inputmap buttons are the default', () => {
  assert.equal(encodeConfig()[1], 0);
  assert.equal(encodeConfig({ raw: true })[1], 1);
});

test('a later HELLO (reconnect) only sends what the glasses miss', () => {
  const { link, sent } = linkWithLog(5);
  link.onMessage(hello(0));
  sent.length = 0;
  link.onMessage(hello(3, link.hello.assetHashes));
  assert.ok(!sent.some((b) => b[0] === CMD.RESET));
  assert.deepEqual(firstSeqs(sent), [4]);
});

test('glasses ahead of the phone (phone reloaded) start clean', () => {
  const { link, sent } = linkWithLog(2);
  link.onMessage(hello(0));
  sent.length = 0;
  link.onMessage(hello(50));
  assert.equal(sent[0][0], CMD.RESET);
});

test('icons go out once; matching hashes are skipped', () => {
  const { link, sent } = linkWithLog(0);
  link.onMessage(hello(0));
  const begins = sent.filter((b) => b[0] === CMD.ASSET_BEGIN);
  assert.equal(begins.length, 12);
  const hashes = begins.map((b) => new DataView(b.buffer).getUint32(9, true));
  sent.length = 0;
  link.onMessage(hello(0, hashes));
  assert.equal(sent.filter((b) => b[0] === CMD.ASSET_BEGIN).length, 0);
});

test('large history is split into small Bluetooth messages', () => {
  const sent = [];
  const link = new NativeLink({ send: (_ch, bytes) => sent.push(bytes) });
  link.onMessage(hello(0));
  sent.length = 0;
  link.addEvents(Array.from({ length: 30 }, () => ({ kind: 'done', title: 'Finished', text: 'x'.repeat(900) })));
  const entries = sent.filter((b) => b[0] === CMD.ENTRIES);
  assert.ok(entries.length > 5);
  assert.ok(entries.every((b) => b.length <= 3100));
});

test('status says what the agent is waiting for', () => {
  const state = createState();
  state.connection = 'online';
  state.sessions.set('a', { project: 'web', state: 'working', last: 'Bash: npm test', at: 2 });
  assert.equal(statusFor(state, 0, null).state, STATE.working);
  assert.equal(statusFor(state, 0, null).waiting, '');
  state.sessions.set('b', { project: 'api', state: 'waiting', last: 'Claude needs your input', at: 1 });
  assert.equal(statusFor(state, 0, null).waiting, 'Needs you (api): Claude needs your input');
  const ask = { id: 'x', kind: 'permission', title: 'Run command', detail: 'npm run deploy' };
  state.pending = [ask, { id: 'y' }];
  assert.equal(statusFor(state, 0, ask).waiting, 'Approve? Run command: npm run deploy  (+1)');
  state.connection = 'offline';
  assert.equal(statusFor(state, 0, ask).state, STATE.offline);
});

test('events become history entries', () => {
  assert.deepEqual(eventToEntry({ kind: 'prompt', title: 'New task', text: 'fix it' }), { kind: KIND.prompt, text: 'fix it' });
  assert.deepEqual(eventToEntry({ kind: 'done', title: 'Finished', text: 'a\nb', project: 'web' }, { showProject: true }),
    { kind: KIND.done, text: '[web] Finished\na\nb' });
});

test('UTF-8 is cut on character boundaries', () => {
  assert.equal(utf8('héllo', 2).length, 1);
  const ask = encodeAsk({ id: 1, risk: 'high', kind: 'permission', seconds: 9, title: '€'.repeat(40), project: 'p', detail: '' });
  const titleLength = ask[9];  // cmd, u32 id, risk, kind, u16 seconds, then the length
  assert.equal(titleLength % 3, 0, 'no half euro sign');
});
