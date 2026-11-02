import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFeed, buildScreen, CONFIRM_WINDOW_MS, createState, diffScreen, dropAsk, handleInput, SETTLE_MS, SCREEN,
} from '../phone/screen.js';

const T0 = 1_000_000;
const ask = (id, extra = {}) => ({
  id, seq: 1, title: 'Run command', detail: 'npm test', project: 'proj', session: 'abc', risk: 'normal', expiresAt: T0 + 60_000, ...extra,
});

function withAsks(asks, now = T0) {
  const state = createState();
  applyFeed(state, { seq: 5, now, events: [], pending: asks }, now);
  return state;
}

test('status screen lists sessions from the feed', () => {
  const state = createState();
  applyFeed(state, {
    seq: 3, now: T0,
    events: [
      { seq: 1, at: T0, kind: 'session', session: 's1', project: 'alpha', title: 'Session started' },
      { seq: 2, at: T0, kind: 'tool', session: 's1', project: 'alpha', title: 'Edit file', text: 'a.js' },
      { seq: 3, at: T0, kind: 'done', session: 's2', project: 'beta', title: 'Finished', text: 'done!' },
    ],
    pending: [],
  }, T0);
  const [header, body, footer] = buildScreen(state, T0);
  assert.match(header.text, /^AGENTS/);
  assert.match(body.text, /alpha {2}working {2}Edit file: a\.js/);
  assert.match(body.text, /beta {2}idle/);
  assert.match(footer.text, /Last: beta done!/);
  assert.equal(state.since, 3);
});

test('ended sessions disappear', () => {
  const state = createState();
  applyFeed(state, { seq: 2, now: T0, pending: [], events: [
    { seq: 1, kind: 'prompt', session: 's1', title: 'New task' },
    { seq: 2, kind: 'session', session: 's1', title: 'Session ended' },
  ] }, T0);
  assert.equal(state.sessions.size, 0);
});

test('every HUD object fits the 600x350 screen and has non-empty text', () => {
  for (const state of [createState(), withAsks([ask('a', { detail: 'x'.repeat(500), risk: 'high' })])]) {
    for (const item of buildScreen(state, T0)) {
      assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.width <= SCREEN.width && item.y + item.height <= SCREEN.height, JSON.stringify(item));
      assert.ok(item.text.length > 0);
      assert.ok(item.id >= 0 && item.id <= 255);
    }
  }
});

test('ask card shows countdown and queue size', () => {
  const state = withAsks([ask('a'), ask('b')]);
  const [header, body, footer] = buildScreen(state, T0 + 15_000);
  assert.match(header.text, /\+1 more/);
  assert.match(body.text, /Run command\nnpm test/);
  assert.match(footer.text, /NOD = allow {3}SHAKE = deny {3}45s/);
});

test('gestures are ignored until the card has settled', () => {
  const state = withAsks([ask('a')]);
  assert.deepEqual(handleInput(state, { type: 'gesture', gesture: 'nod' }, T0 + 100).actions, []);
  assert.deepEqual(handleInput(state, { type: 'gesture', gesture: 'nod' }, T0 + SETTLE_MS).actions, [
    { type: 'answer', id: 'a', decision: 'allow', via: 'nod' },
  ]);
});

test('shake denies', () => {
  const state = withAsks([ask('a')]);
  assert.deepEqual(handleInput(state, { type: 'gesture', gesture: 'shake' }, T0 + SETTLE_MS).actions, [
    { type: 'answer', id: 'a', decision: 'deny', via: 'shake' },
  ]);
});

test('high-risk asks need nod then button within the window', () => {
  const state = withAsks([ask('a', { risk: 'high' })]);
  const t = T0 + SETTLE_MS;
  assert.deepEqual(handleInput(state, { type: 'gesture', gesture: 'nod' }, t).actions, [{ type: 'redraw' }]);
  assert.match(buildScreen(state, t)[2].text, /PRESS BUTTON/);
  assert.deepEqual(handleInput(state, { type: 'button', action: 'single' }, t + 1000).actions, [
    { type: 'answer', id: 'a', decision: 'allow', via: 'nod+button' },
  ]);
});

test('high-risk confirmation expires; a late button press does nothing', () => {
  const state = withAsks([ask('a', { risk: 'high' })]);
  const t = T0 + SETTLE_MS;
  handleInput(state, { type: 'gesture', gesture: 'nod' }, t);
  assert.deepEqual(handleInput(state, { type: 'button', action: 'single' }, t + CONFIRM_WINDOW_MS + 1).actions, []);
});

test('a button press alone never approves', () => {
  const state = withAsks([ask('a')]);
  assert.deepEqual(handleInput(state, { type: 'button', action: 'single' }, T0 + 5000).actions, []);
});

test('double-click cycles between pending asks and resets settling', () => {
  const state = withAsks([ask('a'), ask('b')]);
  handleInput(state, { type: 'button', action: 'double' }, T0 + 2000);
  assert.equal(state.focusId, 'b');
  assert.deepEqual(handleInput(state, { type: 'gesture', gesture: 'nod' }, T0 + 2100).actions, []);
});

test('dropAsk moves focus to the next ask and clears arming', () => {
  const state = withAsks([ask('a', { risk: 'high' }), ask('b')]);
  handleInput(state, { type: 'gesture', gesture: 'nod' }, T0 + SETTLE_MS);
  dropAsk(state, 'a', T0 + 2000);
  assert.equal(state.focusId, 'b');
  assert.equal(state.armed, null);
});

test('diffScreen only returns changed objects', () => {
  const state = withAsks([ask('a')]);
  const first = buildScreen(state, T0);
  const second = buildScreen(state, T0 + 1000);
  const changed = diffScreen(first, second);
  assert.deepEqual(changed.map((item) => item.id), [3]);
});

test('question asks use yes/no wording on the HUD', () => {
  const state = withAsks([ask('q', { kind: 'question', title: 'Merge PR #2 now?', detail: '' })]);
  const [, body, footer] = buildScreen(state, T0);
  assert.equal(body.text, 'Merge PR #2 now?');
  assert.match(footer.text, /^NOD = yes {3}SHAKE = no/);
});
