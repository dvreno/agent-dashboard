// Agent Dashboard: shows Claude Code activity on the glasses and answers
// permission requests with head gestures (nod = allow, shake = deny).
// Runs in the MemoMind App WebView. With the Agent Dashboard glasses plugin
// (glasses/agent_hud) it sends history and cards over its own channel and the
// glasses do the paging; with the stock web_bridge GMP it draws text boxes.

import { createGMPlugin, opusRecordingToOgg } from './vendor/gm-plugin-web-sdk.esm.js';
import { createRelayClient } from './relay-client.js';
import { CH_UP, GLASSES_WINDOW, NativeLink } from './native-link.js';
import {
  applyFeed, buildScreen, createState, diffScreen, dropAsk, focusedAsk, handleInput, MAX_RECORDING_MS,
} from './screen.js';

const STORAGE_KEY = 'agent-dashboard.settings';
const FEED_WAIT_MS = 25_000;
const NATIVE_DETECT_MS = 2500; // wait this long for the glasses plugin's HELLO

const gm = createGMPlugin();
const $ = (id) => document.getElementById(id);
const ui = {
  url: $('relay-url'), token: $('relay-token'), save: $('save'), test: $('test'),
  status: $('status'), connection: $('connection'), asks: $('asks'), log: $('log'),
  history: $('history'), historyCount: $('history-count'),
};

let state = createState();
let client = null;
let lastDrawn = [];
let pageOpen = false;
let pollAbort = null;
let closed = false;
let drawing = Promise.resolve();
let capture = null;          // active glasses-mic recording session
let playedClipId = '';       // last Claude speech clip played
const speaker = new Audio(); // OS routes this (glasses speaker when connected via HFP)
let mode = 'detecting';      // 'native' (agent_hud GMP) | 'bridge' (web_bridge GMP)
let sending = Promise.resolve();
const native = new NativeLink({
  send: (channel, bytes) => {
    // Keep Bluetooth messages in order; one failure must not stall the queue.
    sending = sending.then(() => gm.plugin.sendMessage(channel, bytes)).catch((error) => {
      log(`Glasses send failed: ${error.code || ''} ${error.message || error}`);
    });
  },
  log: (message) => log(message),
});

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
  if (mode === 'native') {
    native.sync(state, Date.now(), focusedAsk(state));
    return drawing;
  }
  if (mode === 'detecting') return drawing;
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
    if (ask.kind === 'listen') {
      ui.asks.append(listenCard(ask));
      continue;
    }
    const card = document.createElement('article');
    card.className = `ask ${ask.risk === 'high' ? 'high' : ''}`;
    const title = document.createElement('h3');
    title.textContent = `${ask.risk === 'high' ? '⚠ ' : ''}${ask.kind === 'question' ? '? ' : ''}${ask.title} · ${ask.project || 'claude'}`;
    const detail = document.createElement('pre');
    detail.textContent = ask.detail;
    const allow = document.createElement('button');
    allow.textContent = ask.kind === 'question' ? 'Yes' : 'Allow';
    allow.className = 'allow';
    allow.onclick = () => answer(ask.id, 'allow', 'phone');
    const deny = document.createElement('button');
    deny.textContent = ask.kind === 'question' ? 'No' : 'Deny';
    deny.className = 'deny';
    deny.onclick = () => answer(ask.id, 'deny', 'phone');
    card.append(title, detail, allow, deny);
    ui.asks.append(card);
  }
}

function listenCard(ask) {
  const card = document.createElement('article');
  card.className = 'ask listen';
  const title = document.createElement('h3');
  title.textContent = `Claude · ${ask.project || 'claude'}`;
  const captions = document.createElement('pre');
  captions.textContent = ask.detail;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a reply…';
  const send = document.createElement('button');
  send.textContent = 'Send';
  send.onclick = () => {
    if (input.value.trim()) void answer(ask.id, 'reply', 'typed', { text: input.value.trim() });
  };
  input.onkeydown = (event) => { if (event.key === 'Enter') send.onclick(); };
  const talk = document.createElement('button');
  talk.className = 'secondary';
  talk.textContent = state.recording?.askId === ask.id ? 'Stop & send' : 'Talk (glasses mic)';
  talk.onclick = () => (state.recording?.askId === ask.id ? stopRecording() : startRecording(ask.id));
  const end = document.createElement('button');
  end.className = 'deny';
  end.textContent = 'End';
  end.onclick = () => answer(ask.id, 'deny', 'phone');
  const row = document.createElement('div');
  row.className = 'row';
  row.append(send, talk, end);
  card.append(title, captions, input, row);
  return card;
}

// ---- voice ----------------------------------------------------------------------

async function startRecording(askId) {
  if (capture || !client) return;
  try {
    speaker.pause();
    capture = await gm.audio.openRecording({ pickupMode: 'frontFocus', noiseReduction: true, maxDurationMs: MAX_RECORDING_MS });
    state.recording = { askId, startedAt: Date.now() };
    log('Recording reply…');
    native.notice('Recording - click to send');
  } catch (error) {
    capture = null;
    log(`Mic unavailable: ${error.code || ''} ${error.message || error}`);
  }
  renderPhoneAsks();
  draw();
}

async function stopRecording() {
  const session = capture;
  const recording = state.recording;
  if (!session || !recording) return;
  capture = null;
  state.recording = null;
  state.sending = recording.askId;
  native.notice('Sending your reply');
  draw();
  try {
    const result = await session.stop();
    const blob = opusRecordingToOgg(result);
    const clip = await client.uploadClip(blob);
    await answer(recording.askId, 'reply', 'voice', { clipId: clip.id });
  } catch (error) {
    log(`Reply failed: ${error.code || ''} ${error.message || error}`);
  } finally {
    state.sending = null;
    renderPhoneAsks();
    draw();
  }
}

// Play Claude's spoken reply once, when its clip is attached to the focused card.
async function playSpeech() {
  const ask = focusedAsk(state);
  if (!client || ask?.kind !== 'listen' || !ask.clipId || ask.clipId === playedClipId || state.recording) return;
  playedClipId = ask.clipId;
  try {
    const blob = await client.downloadClip(ask.clipId);
    if (speaker.src) URL.revokeObjectURL(speaker.src);
    speaker.src = URL.createObjectURL(blob);
    await speaker.play();
  } catch (error) {
    log(`Speech playback failed: ${error.message || error}`);
  }
}

// ---- relay --------------------------------------------------------------------

async function answer(id, decision, via, extra) {
  if (!client) return false;
  let ok = false;
  try {
    await client.answer(id, decision, via, extra);
    log(`${decision.toUpperCase()} via ${via}`);
    ok = true;
  } catch (error) {
    log(`Answer failed: ${error.message}`); // 409 = already answered/expired; the next feed corrects the view
  }
  // On failure keep the card so it can be retried; the next feed drops it if it is gone.
  if (ok) dropAsk(state, id, Date.now());
  renderPhoneAsks();
  draw();
  return ok;
}


const KIND_LABEL = ['you', 'tool', 'text', 'done', 'error', 'ask', 'note', 'system'];

/** Full history on the phone; the glasses only keep the last few events. */
function renderHistory() {
  const entries = native.history();
  const items = entries.slice(-200).reverse().map((entry) => {
    const item = document.createElement('li');
    item.dataset.kind = KIND_LABEL[entry.kind] ?? 'text';
    const label = document.createElement('span');
    label.className = 'kind';
    label.textContent = KIND_LABEL[entry.kind] ?? 'text';
    const text = document.createElement('pre');
    text.textContent = entry.text;
    item.append(label, text);
    return item;
  });
  ui.history.replaceChildren(...items);
  ui.historyCount.textContent = entries.length
    ? `${entries.length} events; the glasses show the last ${Math.min(entries.length, GLASSES_WINDOW)}.`
    : 'Nothing yet.';
}

async function pollLoop() {
  let backoff = 1000;
  while (!closed && client) {
    pollAbort = new AbortController();
    try {
      const feed = await client.feed(state.since, FEED_WAIT_MS, pollAbort.signal);
      const hadFocus = focusedAsk(state)?.id;
      applyFeed(state, feed, Date.now());
      native.addEvents(feed.events, { showProject: state.sessions.size > 1 });
      if (feed.events.length) renderHistory();
      setConnection('online');
      backoff = 1000;
      for (const event of feed.events) log(`${event.project || event.session}: ${event.title}${event.text ? ` — ${event.text}` : ''}`);
      if (focusedAsk(state)?.id !== hadFocus) renderPhoneAsks();
      draw();
      void playSpeech();
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
  native.reset();
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

// ---- native glasses plugin ----------------------------------------------------------

async function onGlassesMessage(message) {
  if (message.channel !== CH_UP) return;
  const { message: decoded, actions } = native.onMessage(message.data);
  if (decoded.type === 'hello' && mode !== 'native') {
    mode = 'native';
    log('Using the Agent Dashboard glasses plugin');
  }
  for (const action of actions) {
    if (action.type === 'resync') draw();
    if (action.type !== 'answer') continue;
    if (action.decision === 'talk') {
      if (state.recording?.askId === action.id) void stopRecording();
      else void startRecording(action.id);
      continue;
    }
    const ok = await answer(action.id, action.decision, action.via);
    native.ackAnswer(action.id, ok);
  }
}

// ---- device input -------------------------------------------------------------

function onInput(input) {
  const { actions } = handleInput(state, input, Date.now());
  for (const action of actions) {
    if (action.type === 'answer') void answer(action.id, action.decision, action.via);
    if (action.type === 'redraw') draw();
    if (action.type === 'record-start') void startRecording(action.id);
    if (action.type === 'record-stop') void stopRecording();
  }
}

// Countdown refresh: only the footer text changes, and only while a card is shown.
setInterval(() => {
  // Native mode diffs, so this only sends when the clock or a card changes.
  if (mode === 'native' || focusedAsk(state) || state.armed) draw();
  // The SDK caps short recordings; send automatically at the limit.
  if (state.recording && Date.now() - state.recording.startedAt >= MAX_RECORDING_MS) void stopRecording();
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
      if (event.connected && mode === 'native') native.start();
      if (event.connected && mode === 'bridge') {
        pageOpen = false;
        draw(true);
      }
    });
    gm.audio.onCaptureState((event) => {
      if (event.state === 'stopped' && capture) void stopRecording();
      if (event.state === 'error') log(`Mic error: ${event.errorCode || event.message || 'unknown'}`);
    });
    try {
      gm.plugin.onMessage((message) => void onGlassesMessage(message));
      native.start();
    } catch (error) {
      log(`Glasses plugin channel unavailable: ${error.code || ''} ${error.message || error}`);
    }
    setTimeout(() => {
      if (mode !== 'detecting') return;
      mode = 'bridge';
      log('No Agent Dashboard glasses plugin answered; using the web bridge');
      draw(true);
    }, NATIVE_DETECT_MS);
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
