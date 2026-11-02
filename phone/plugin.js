// Agent Dashboard: shows Claude Code activity on the glasses and answers
// permission requests with head gestures (nod = allow, shake = deny).
// Runs in the MemoMind App WebView and draws through the existing web_bridge GMP.

import { createGMPlugin } from './vendor/gm-plugin-web-sdk.esm.js';
import { createRelayClient } from './relay-client.js';
import {
  applyFeed, buildScreen, createState, diffScreen, dropAsk, focusedAsk, handleInput,
} from './screen.js';

const STORAGE_KEY = 'agent-dashboard.settings';
const FEED_WAIT_MS = 25_000;

const gm = createGMPlugin();
const $ = (id) => document.getElementById(id);
const ui = {
  url: $('relay-url'), token: $('relay-token'), save: $('save'), test: $('test'),
  status: $('status'), connection: $('connection'), asks: $('asks'), log: $('log'),
};

let state = createState();
let client = null;
let lastDrawn = [];
let pageOpen = false;
let pollAbort = null;
let closed = false;
let drawing = Promise.resolve();

function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  ui.log.textContent = `${line}\n${ui.log.textContent}`.slice(0, 4000);
}

function setStatus(message) {
  ui.status.textContent = message;
}

function setConnection(value) {
  state.connection = value;
  ui.connection.textContent = value;
  ui.connection.dataset.state = value;
}

// ---- glasses rendering ------------------------------------------------------

function draw(force = false) {
  // Serialise draws so Bridge requests never interleave.
  drawing = drawing.then(async () => {
    if (closed) return;
    try {
      if (!pageOpen) {
        await gm.display.createPage();
        pageOpen = true;
        force = true;
      }
      const next = buildScreen(state, Date.now());
      const changed = force ? next : diffScreen(lastDrawn, next);
      for (const item of changed) await gm.display.updateText(item);
      lastDrawn = next;
    } catch (error) {
      pageOpen = false;
      lastDrawn = [];
      log(`Draw failed: ${error.code || ''} ${error.message || error}`);
    }
  });
  return drawing;
}

// ---- phone UI -----------------------------------------------------------------

function renderPhoneAsks() {
  ui.asks.replaceChildren();
  if (!state.pending.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No approvals waiting.';
    ui.asks.append(empty);
    return;
  }
  for (const ask of state.pending) {
    const card = document.createElement('article');
    card.className = `ask ${ask.risk === 'high' ? 'high' : ''}`;
    const title = document.createElement('h3');
    title.textContent = `${ask.risk === 'high' ? '⚠ ' : ''}${ask.title} · ${ask.project || 'claude'}`;
    const detail = document.createElement('pre');
    detail.textContent = ask.detail;
    const allow = document.createElement('button');
    allow.textContent = 'Allow';
    allow.className = 'allow';
    allow.onclick = () => answer(ask.id, 'allow', 'phone');
    const deny = document.createElement('button');
    deny.textContent = 'Deny';
    deny.className = 'deny';
    deny.onclick = () => answer(ask.id, 'deny', 'phone');
    card.append(title, detail, allow, deny);
    ui.asks.append(card);
  }
}

// ---- relay --------------------------------------------------------------------

async function answer(id, decision, via) {
  if (!client) return;
  try {
    await client.answer(id, decision, via);
    log(`${decision.toUpperCase()} via ${via}`);
  } catch (error) {
    log(`Answer failed: ${error.message}`); // 409 = already answered/expired; the next feed corrects the view
  }
  dropAsk(state, id, Date.now());
  renderPhoneAsks();
  draw();
}

async function pollLoop() {
  let backoff = 1000;
  while (!closed && client) {
    pollAbort = new AbortController();
    try {
      const feed = await client.feed(state.since, FEED_WAIT_MS, pollAbort.signal);
      const hadFocus = focusedAsk(state)?.id;
      applyFeed(state, feed, Date.now());
      setConnection('online');
      backoff = 1000;
      for (const event of feed.events) log(`${event.project || event.session}: ${event.title}${event.text ? ` — ${event.text}` : ''}`);
      if (focusedAsk(state)?.id !== hadFocus) renderPhoneAsks();
      draw();
    } catch (error) {
      if (closed || pollAbort.signal.aborted) return;
      setConnection(error.status === 401 ? 'bad token' : 'offline');
      log(`Relay error: ${error.message}`);
      draw();
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

function startPolling() {
  pollAbort?.abort();
  state = createState();
  lastDrawn = [];
  setConnection('connecting');
  void pollLoop();
}

async function loadSettings() {
  const saved = (await gm.storage.get(STORAGE_KEY)).value || {};
  ui.url.value = saved.url || '';
  ui.token.value = saved.token || '';
  return saved;
}

function makeClient(url, token) {
  client = createRelayClient({ url, token });
}

ui.save.addEventListener('click', async () => {
  try {
    makeClient(ui.url.value, ui.token.value.trim());
    await gm.storage.set(STORAGE_KEY, { url: ui.url.value.trim(), token: ui.token.value.trim() });
    setStatus('Saved. Connecting…');
    startPolling();
  } catch (error) {
    setStatus(error.message);
  }
});

ui.test.addEventListener('click', async () => {
  try {
    const probe = createRelayClient({ url: ui.url.value, token: ui.token.value.trim() });
    const feed = await probe.check();
    setStatus(`Connected. ${feed.pending.length} pending, last event #${feed.seq}.`);
  } catch (error) {
    setStatus(error.status === 401 ? 'Wrong token.' : `Cannot reach relay: ${error.message}`);
  }
});

// ---- device input -------------------------------------------------------------

function onInput(input) {
  const { actions } = handleInput(state, input, Date.now());
  for (const action of actions) {
    if (action.type === 'answer') void answer(action.id, action.decision, action.via);
    if (action.type === 'redraw') draw();
  }
}

// Countdown refresh: only the footer text changes, and only while a card is shown.
setInterval(() => {
  if (focusedAsk(state) || state.armed) draw();
}, 1000);

// ---- startup ------------------------------------------------------------------

async function start() {
  try {
    await gm.ready();
    await gm.device.subscribeEvents(['button', 'imuGesture', 'connection']);
    gm.device.onButton((event) => onInput({ type: 'button', action: event.action }));
    gm.device.onGesture((event) => {
      if (event.active !== false) onInput({ type: 'gesture', gesture: event.gesture });
    });
    gm.device.onConnection((event) => {
      log(event.connected ? 'Glasses connected' : 'Glasses disconnected');
      if (event.connected) {
        pageOpen = false;
        draw(true);
      }
    });
    gm.on('runtime.lifecycleChanged', (event) => log(`Lifecycle: ${event.state || JSON.stringify(event)}`));

    const saved = await loadSettings();
    renderPhoneAsks();
    if (saved.url && saved.token) {
      makeClient(saved.url, saved.token);
      setStatus('Connecting to relay…');
      startPolling();
    } else {
      setStatus('Enter your relay URL and token, then Save.');
      setConnection('not configured');
      draw(true);
    }
  } catch (error) {
    setStatus(`${error.code || 'ERROR'}: ${error.message || error}. Check permissions, then reload.`);
  }
}

window.addEventListener('pagehide', () => {
  closed = true;
  pollAbort?.abort();
  gm.close();
});

void start();
