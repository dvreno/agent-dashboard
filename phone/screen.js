// Pure HUD logic for the Agent Dashboard: session tracking, screen layout for the
// 600x350 glasses display, and gesture/button handling. No DOM or Bridge access,
// so it can be unit-tested in Node.

export const SCREEN = { width: 600, height: 350 };
export const CONFIRM_WINDOW_MS = 5000;   // time to press the button after a nod on a high-risk ask
export const SETTLE_MS = 800;            // ignore gestures right after a new card appears
const MAX_SESSIONS = 4;

const BLANK = ' '; // updateText requires non-empty text

export function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatClock(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function createState() {
  return {
    since: 0,
    sessions: new Map(), // key -> { project, session, state, last, at }
    lastDone: null,
    pending: [],
    focusId: null,      // ask currently shown
    shownAt: 0,         // when the focused ask first appeared
    armed: null,        // { askId, until }
    serverOffset: 0,    // relay clock minus phone clock
    connection: 'connecting',
  };
}

const SESSION_STATE = {
  session: 'started',
  prompt: 'working',
  tool: 'working',
  status: 'working',
  notify: 'waiting',
  done: 'idle',
  error: 'error',
};

export function applyFeed(state, feed, phoneNow) {
  state.serverOffset = (feed.now || phoneNow) - phoneNow;
  for (const event of feed.events || []) {
    state.since = Math.max(state.since, event.seq);
    const key = event.session || event.project || 'agent';
    if (event.kind === 'session' && /ended/i.test(event.title)) {
      state.sessions.delete(key);
      continue;
    }
    const entry = state.sessions.get(key) || { session: event.session, project: event.project };
    entry.project = event.project || entry.project;
    entry.state = SESSION_STATE[event.kind] || 'working';
    entry.last = event.kind === 'tool' ? `${event.title}: ${event.text}` : event.title;
    entry.at = event.at;
    state.sessions.set(key, entry);
    if (event.kind === 'done' || event.kind === 'error') state.lastDone = event;
  }
  state.since = Math.max(state.since, Math.min(feed.seq || 0, Number.MAX_SAFE_INTEGER));
  state.pending = feed.pending || [];
  refocus(state, phoneNow);
}

function refocus(state, phoneNow) {
  if (!state.pending.some((ask) => ask.id === state.focusId)) {
    state.focusId = state.pending[0]?.id ?? null;
    state.shownAt = phoneNow;
    state.armed = null;
  }
}

export function focusedAsk(state) {
  return state.pending.find((ask) => ask.id === state.focusId) || null;
}

// Returns { actions: [...] } where an action is { type: 'answer', id, decision, via } or { type: 'redraw' }.
export function handleInput(state, input, phoneNow) {
  const ask = focusedAsk(state);
  const actions = [];
  if (state.armed && phoneNow > state.armed.until) state.armed = null;
  if (!ask) return { actions };

  const settled = phoneNow - state.shownAt >= SETTLE_MS;
  if (input.type === 'gesture' && input.gesture === 'nod' && settled) {
    if (ask.risk === 'high') {
      state.armed = { askId: ask.id, until: phoneNow + CONFIRM_WINDOW_MS };
      actions.push({ type: 'redraw' });
    } else {
      actions.push({ type: 'answer', id: ask.id, decision: 'allow', via: 'nod' });
    }
  } else if (input.type === 'gesture' && input.gesture === 'shake' && settled) {
    state.armed = null;
    actions.push({ type: 'answer', id: ask.id, decision: 'deny', via: 'shake' });
  } else if (input.type === 'button' && input.action === 'single') {
    if (state.armed && state.armed.askId === ask.id) {
      state.armed = null;
      actions.push({ type: 'answer', id: ask.id, decision: 'allow', via: 'nod+button' });
    }
  } else if (input.type === 'button' && input.action === 'double' && state.pending.length > 1) {
    const index = state.pending.findIndex((item) => item.id === ask.id);
    state.focusId = state.pending[(index + 1) % state.pending.length].id;
    state.shownAt = phoneNow;
    state.armed = null;
    actions.push({ type: 'redraw' });
  }
  return { actions };
}

// Remove an answered ask locally so the HUD moves on immediately.
export function dropAsk(state, id, phoneNow) {
  state.pending = state.pending.filter((ask) => ask.id !== id);
  refocus(state, phoneNow);
}

// ---- layout ---------------------------------------------------------------

function text(id, x, y, width, height, value, { border = 0, radius = 0 } = {}) {
  return { id, x, y, width, height, border, radius, text: value || BLANK };
}

export function buildScreen(state, phoneNow) {
  const ask = focusedAsk(state);
  return ask ? askScreen(state, ask, phoneNow) : statusScreen(state, phoneNow);
}

function askScreen(state, ask, phoneNow) {
  const serverNow = phoneNow + state.serverOffset;
  const secondsLeft = Math.max(0, Math.ceil((ask.expiresAt - serverNow) / 1000));
  const more = state.pending.length > 1 ? `  (+${state.pending.length - 1} more, double-click)` : '';
  const header = `${ask.risk === 'high' ? '!! HIGH RISK  ' : ''}${clip(ask.project || 'claude', 24)}${ask.session ? ` · ${ask.session}` : ''}${more}`;
  const body = `${clip(ask.title, 40)}\n${clip(ask.detail, 150)}`;
  let footer;
  if (state.armed && state.armed.askId === ask.id && phoneNow <= state.armed.until) {
    const left = Math.max(0, Math.ceil((state.armed.until - phoneNow) / 1000));
    footer = `PRESS BUTTON to confirm (${left}s)   SHAKE = deny`;
  } else {
    footer = `NOD = allow   SHAKE = deny   ${secondsLeft}s`;
  }
  return [
    text(1, 10, 6, 580, 40, header),
    text(2, 10, 50, 580, 210, body, { border: 2, radius: 10 }),
    text(3, 10, 268, 580, 76, footer),
  ];
}

function statusScreen(state, phoneNow) {
  const sessions = [...state.sessions.values()]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, MAX_SESSIONS);
  const connection = state.connection === 'online' ? '' : `  [${state.connection}]`;
  const header = `AGENTS  ${formatClock(phoneNow)}${connection}`;
  const lines = sessions.length
    ? sessions.map((entry) => `${clip(entry.project || entry.session, 16)}  ${entry.state}  ${clip(entry.last, 30)}`).join('\n')
    : 'No active Claude Code sessions';
  const done = state.lastDone ? `Last: ${clip(state.lastDone.project, 16)} ${clip(state.lastDone.text || state.lastDone.title, 60)}` : 'No approvals waiting';
  return [
    text(1, 10, 6, 580, 40, header),
    text(2, 10, 50, 580, 210, lines, { border: 1, radius: 10 }),
    text(3, 10, 268, 580, 76, done),
  ];
}

// Only send objects whose content changed since the last draw (saves Bluetooth bandwidth).
export function diffScreen(previous, next) {
  const before = new Map((previous || []).map((item) => [item.id, JSON.stringify(item)]));
  return next.filter((item) => before.get(item.id) !== JSON.stringify(item));
}
