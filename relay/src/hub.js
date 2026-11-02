// Core relay state machine: an event feed plus pending yes/no "asks".
// Pure JS with an injectable clock and timer so it can be unit-tested in Node
// and wrapped by a Cloudflare Durable Object in production.

export const MAX_EVENTS = 100;
export const MAX_PENDING_ASKS = 20;
export const MAX_WAIT_MS = 25_000;
export const DEFAULT_ASK_TTL_MS = 120_000;
export const MAX_ASK_TTL_MS = 600_000;
// Keep answered/expired asks around so a polling hook can still read the result.
export const RESOLVED_RETENTION_MS = 10 * 60_000;

const EVENT_KINDS = new Set(['session', 'prompt', 'tool', 'notify', 'done', 'error', 'status']);
const DECISIONS = new Set(['allow', 'deny']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function str(value, max, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export class Hub {
  // Default timers are wrapped: Workers throw "Illegal invocation" if setTimeout
  // is called as a method of another object (this.setTimer(...)).
  constructor({
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    randomId,
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.randomId = randomId || (() => crypto.randomUUID());
    this.seq = 0;
    this.events = [];
    this.asks = new Map();
    this.feedWaiters = new Set();
    this.askWaiters = new Map();
  }

  // ---- persistence -------------------------------------------------------
  snapshot() {
    return { seq: this.seq, events: this.events, asks: [...this.asks.values()] };
  }

  restore(data) {
    if (!data) return;
    this.seq = data.seq || 0;
    this.events = Array.isArray(data.events) ? data.events : [];
    this.asks = new Map((data.asks || []).map((ask) => [ask.id, ask]));
  }

  // ---- events --------------------------------------------------------------
  addEvent(input) {
    const kind = str(input?.kind, 20, 'kind', { required: true });
    if (!EVENT_KINDS.has(kind)) throw new HttpError(400, `unknown kind: ${kind}`);
    const event = {
      seq: ++this.seq,
      at: this.now(),
      kind,
      session: str(input.session, 64, 'session'),
      project: str(input.project, 60, 'project'),
      title: str(input.title, 80, 'title'),
      text: str(input.text, 400, 'text'),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.notifyFeed();
    return event;
  }

  // ---- asks ----------------------------------------------------------------
  createAsk(input) {
    this.expireAsks();
    const pending = [...this.asks.values()].filter((ask) => ask.state === 'pending');
    if (pending.length >= MAX_PENDING_ASKS) throw new HttpError(429, 'too many pending asks');
    const ttl = Math.min(Math.max(Number(input?.timeoutMs) || DEFAULT_ASK_TTL_MS, 5_000), MAX_ASK_TTL_MS);
    const risk = input?.risk === 'high' ? 'high' : 'normal';
    const kind = input?.kind === 'question' ? 'question' : 'permission';
    const ask = {
      id: this.randomId(),
      seq: ++this.seq,
      createdAt: this.now(),
      expiresAt: this.now() + ttl,
      state: 'pending',
      kind,
      risk,
      session: str(input?.session, 64, 'session'),
      project: str(input?.project, 60, 'project'),
      title: str(input?.title, 80, 'title', { required: true }),
      detail: str(input?.detail, 400, 'detail'),
      reason: '',
      via: '',
      answeredAt: 0,
    };
    this.asks.set(ask.id, ask);
    this.notifyFeed();
    return ask;
  }

  getAsk(id) {
    this.expireAsks();
    const ask = this.asks.get(id);
    if (!ask) throw new HttpError(404, 'ask not found');
    return ask;
  }

  answerAsk(id, input) {
    const ask = this.getAsk(id);
    const decision = input?.decision;
    if (!DECISIONS.has(decision)) throw new HttpError(400, 'decision must be allow or deny');
    if (ask.state !== 'pending') throw new HttpError(409, `ask already ${ask.state}`);
    ask.state = decision;
    ask.via = str(input.via, 20, 'via') || 'unknown';
    ask.reason = str(input.reason, 200, 'reason');
    ask.answeredAt = this.now();
    this.seq += 1; // any state change advances the feed so pollers refresh
    this.resolveAskWaiters(ask);
    this.notifyFeed();
    return ask;
  }

  cancelAsk(id) {
    const ask = this.getAsk(id);
    if (ask.state === 'pending') {
      ask.state = 'cancelled';
      ask.answeredAt = this.now();
      this.seq += 1;
      this.resolveAskWaiters(ask);
      this.notifyFeed();
    }
    return ask;
  }

  pendingAsks() {
    this.expireAsks();
    return [...this.asks.values()]
      .filter((ask) => ask.state === 'pending')
      .sort((a, b) => a.seq - b.seq);
  }

  expireAsks() {
    const now = this.now();
    let changed = false;
    for (const ask of this.asks.values()) {
      if (ask.state === 'pending' && now >= ask.expiresAt) {
        ask.state = 'expired';
        ask.answeredAt = now;
        this.seq += 1;
        this.resolveAskWaiters(ask);
        changed = true;
      } else if (ask.state !== 'pending' && now - ask.answeredAt > RESOLVED_RETENTION_MS) {
        this.asks.delete(ask.id);
      }
    }
    if (changed) this.notifyFeed();
  }

  // ---- feed ----------------------------------------------------------------
  feed(since = 0) {
    return {
      seq: this.seq,
      now: this.now(),
      events: this.events.filter((event) => event.seq > since),
      pending: this.pendingAsks(),
    };
  }

  // Long-poll: resolves as soon as anything newer than `since` exists, or after waitMs.
  waitFeed(since, waitMs) {
    this.expireAsks();
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MAX_WAIT_MS);
    if (this.seq > since || wait === 0) return Promise.resolve(this.feed(since));
    return new Promise((resolve) => {
      const waiter = { resolve: () => resolve(this.feed(since)), timer: null };
      waiter.timer = this.setTimer(() => {
        this.feedWaiters.delete(waiter);
        waiter.resolve();
      }, this.nextWakeDelay(wait));
      this.feedWaiters.add(waiter);
    });
  }

  waitAsk(id, waitMs) {
    const ask = this.getAsk(id);
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MAX_WAIT_MS);
    if (ask.state !== 'pending' || wait === 0) return Promise.resolve(ask);
    return new Promise((resolve) => {
      const waiters = this.askWaiters.get(id) || new Set();
      const waiter = { resolve, timer: null };
      waiter.timer = this.setTimer(() => {
        waiters.delete(waiter);
        this.expireAsks();
        resolve(this.asks.get(id) || ask);
      }, Math.min(wait, Math.max(ask.expiresAt - this.now(), 0)));
      waiters.add(waiter);
      this.askWaiters.set(id, waiters);
    });
  }

  // Wake feed waiters early when an ask is about to expire so the HUD updates.
  nextWakeDelay(wait) {
    const now = this.now();
    let delay = wait;
    for (const ask of this.asks.values()) {
      if (ask.state === 'pending') delay = Math.min(delay, Math.max(ask.expiresAt - now, 0));
    }
    return delay;
  }

  notifyFeed() {
    for (const waiter of this.feedWaiters) {
      this.clearTimer(waiter.timer);
      waiter.resolve();
    }
    this.feedWaiters.clear();
  }

  resolveAskWaiters(ask) {
    const waiters = this.askWaiters.get(ask.id);
    if (!waiters) return;
    for (const waiter of waiters) {
      this.clearTimer(waiter.timer);
      waiter.resolve(ask);
    }
    this.askWaiters.delete(ask.id);
  }
}
