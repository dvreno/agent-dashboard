import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HttpError, MAX_EVENTS, MAX_PENDING_ASKS } from '../relay/src/hub.js';

// Deterministic clock + timers.
function fakeEnv() {
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map();
  let timerId = 0;
  return {
    now: () => now,
    randomId: () => `ask-${++nextId}`,
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: now + ms }); return timerId; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

test('events are appended with increasing seq and capped', () => {
  const hub = new Hub(fakeEnv());
  for (let i = 0; i < MAX_EVENTS + 5; i += 1) hub.addEvent({ kind: 'tool', title: `t${i}` });
  assert.equal(hub.events.length, MAX_EVENTS);
  assert.equal(hub.events.at(-1).seq, MAX_EVENTS + 5);
  assert.equal(hub.feed(MAX_EVENTS + 3).events.length, 2);
});

test('event validation rejects unknown kinds and truncates long text', () => {
  const hub = new Hub(fakeEnv());
  assert.throws(() => hub.addEvent({ kind: 'bogus' }), HttpError);
  assert.throws(() => hub.addEvent({}), /kind is required/);
  const event = hub.addEvent({ kind: 'notify', text: 'x'.repeat(1000) });
  assert.equal(event.text.length, 400);
  const done = hub.addEvent({ kind: 'done', text: 'y'.repeat(9000) });
  assert.equal(done.text.length, 4000, 'final messages keep enough for scroll-back');
});

test('ask lifecycle: pending → allow, waiters resolve, second answer conflicts', async () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  const ask = hub.createAsk({ title: 'Run command', detail: 'ls', timeoutMs: 60_000 });
  assert.equal(ask.state, 'pending');
  const waiting = hub.waitAsk(ask.id, 20_000);
  hub.answerAsk(ask.id, { decision: 'allow', via: 'nod' });
  assert.equal((await waiting).state, 'allow');
  assert.throws(() => hub.answerAsk(ask.id, { decision: 'deny' }), /already allow/);
  assert.equal(hub.pendingAsks().length, 0);
});

test('invalid decisions are rejected', () => {
  const hub = new Hub(fakeEnv());
  const ask = hub.createAsk({ title: 'x' });
  assert.throws(() => hub.answerAsk(ask.id, { decision: 'yes' }), /allow or deny/);
  assert.throws(() => hub.answerAsk('missing', { decision: 'allow' }), /not found/);
});

test('asks expire and are never auto-approved', async () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  const ask = hub.createAsk({ title: 'x', timeoutMs: 10_000 });
  const waiting = hub.waitAsk(ask.id, 25_000);
  env.advance(10_001);
  const result = await waiting;
  assert.equal(result.state, 'expired');
  assert.throws(() => hub.answerAsk(ask.id, { decision: 'allow' }), /already expired/);
});

test('ask timeout is clamped to sane bounds', () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  assert.equal(hub.createAsk({ title: 'x', timeoutMs: 1 }).expiresAt - env.now(), 5_000);
  assert.equal(hub.createAsk({ title: 'x', timeoutMs: 1e9 }).expiresAt - env.now(), 600_000);
});

test('too many pending asks returns 429', () => {
  const hub = new Hub(fakeEnv());
  for (let i = 0; i < MAX_PENDING_ASKS; i += 1) hub.createAsk({ title: `a${i}` });
  assert.throws(() => hub.createAsk({ title: 'overflow' }), (error) => error.status === 429);
});

test('feed long-poll wakes on new event and on ask state changes', async () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  const first = hub.waitFeed(0, 25_000);
  const ask = hub.createAsk({ title: 'Edit file' });
  const feed = await first;
  assert.equal(feed.pending.length, 1);

  const second = hub.waitFeed(feed.seq, 25_000);
  hub.cancelAsk(ask.id);
  const after = await second;
  assert.equal(after.pending.length, 0);
  assert.ok(after.seq > feed.seq, 'cancel advances seq so late pollers refresh');
});

test('feed long-poll returns after timeout with no changes', async () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  hub.addEvent({ kind: 'tool', title: 'x' });
  const waiting = hub.waitFeed(hub.seq, 25_000);
  env.advance(25_000);
  const feed = await waiting;
  assert.equal(feed.events.length, 0);
});

test('feed waiter wakes early when a pending ask expires', async () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  hub.createAsk({ title: 'x', timeoutMs: 6_000 });
  const waiting = hub.waitFeed(hub.seq, 25_000);
  env.advance(6_000);
  const feed = await waiting;
  assert.equal(feed.pending.length, 0);
});

test('snapshot/restore round-trips state', () => {
  const hub = new Hub(fakeEnv());
  hub.addEvent({ kind: 'done', title: 'Finished' });
  const ask = hub.createAsk({ title: 'x' });
  const copy = new Hub(fakeEnv());
  copy.restore(JSON.parse(JSON.stringify(hub.snapshot())));
  assert.equal(copy.seq, hub.seq);
  assert.equal(copy.getAsk(ask.id).title, 'x');
});

test('resolved asks are purged after retention', () => {
  const env = fakeEnv();
  const hub = new Hub(env);
  const ask = hub.createAsk({ title: 'x' });
  hub.answerAsk(ask.id, { decision: 'deny' });
  env.advance(11 * 60_000);
  assert.throws(() => hub.getAsk(ask.id), /not found/);
});

test('asks default to kind=permission and accept kind=question', () => {
  const hub = new Hub(fakeEnv());
  assert.equal(hub.createAsk({ title: 'x' }).kind, 'permission');
  assert.equal(hub.createAsk({ title: 'y', kind: 'question' }).kind, 'question');
  assert.equal(hub.createAsk({ title: 'z', kind: 'bogus' }).kind, 'permission');
});

test('listen asks accept reply (text or clip) or deny, not allow', async () => {
  const hub = new Hub(fakeEnv());
  const ask = hub.createAsk({ title: 'Claude', kind: 'listen', detail: 'x'.repeat(1500) });
  assert.equal(ask.detail.length, 1500, 'listen captions keep up to 2000 chars');
  assert.throws(() => hub.answerAsk(ask.id, { decision: 'allow' }), /reply or deny/);
  assert.throws(() => hub.answerAsk(ask.id, { decision: 'reply' }), /text or clipId/);
  assert.throws(() => hub.answerAsk(ask.id, { decision: 'reply', clipId: '../etc/passwd' }), /invalid clipId/);
  const waiting = hub.waitAsk(ask.id, 5000);
  hub.answerAsk(ask.id, { decision: 'reply', clipId: '0b7f6a1e-1111-4222-8333-944455556666', via: 'voice' });
  const done = await waiting;
  assert.equal(done.state, 'reply');
  assert.equal(done.reply.clipId, '0b7f6a1e-1111-4222-8333-944455556666');
});

test('attachClip adds speech to a pending ask and wakes the feed', async () => {
  const hub = new Hub(fakeEnv());
  const ask = hub.createAsk({ title: 'Claude', kind: 'listen' });
  const waiting = hub.waitFeed(hub.seq, 25_000);
  hub.attachClip(ask.id, { clipId: 'abcdef12-0000-4000-8000-000000000000' });
  const feed = await waiting;
  assert.equal(feed.pending[0].clipId, 'abcdef12-0000-4000-8000-000000000000');
  hub.answerAsk(ask.id, { decision: 'deny' });
  assert.throws(() => hub.attachClip(ask.id, { clipId: 'abcdef12-0000-4000-8000-000000000000' }), /already/);
});
