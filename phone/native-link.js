// Phone side of the native glasses plugin (glasses/agent_hud). Encodes relay
// activity into the binary protocol in glasses/agent_hud/agent_proto.h and
// decodes what the glasses send back. Pure logic: the caller provides send().
//
// What goes over Bluetooth: each history entry once (the glasses keep the
// scroll-back and page locally), a small status message when it changes,
// approval cards, and the icon set once (only icons the glasses lack).

import { assetMessages, asciiToLevels } from './lib/hud-render-kit.js';
import { ICONS } from './icons.js';

export const PROTO_VERSION = 1;
export const CH_DOWN = 0x4144;
export const CH_UP = 0x4145;

export const CMD = {
  HELLO_REQ: 0x01, ENTRIES: 0x02, STATUS: 0x03, ASK: 0x04, ASK_CLEAR: 0x05, RESET: 0x06,
  ASSET_BEGIN: 0x07, ASSET_TILE: 0x08, FB_TILE: 0x09, CONFIG: 0x0a, ANSWER_ACK: 0x0b, NOTICE: 0x0c,
};
export const EVT = { HELLO: 0x81, ANSWER: 0x82, NEED: 0x83, ASSET: 0x84, INPUT: 0x85, VIEW: 0x86 };
export const KIND = { prompt: 0, tool: 1, text: 2, done: 3, error: 4, ask: 5, notify: 6, system: 7 };
export const STATE = { offline: 0, idle: 1, working: 2, waiting: 3, error: 4 };
const DECISIONS = { 1: 'allow', 2: 'deny', 3: 'talk' };
const VIAS = { 1: 'nod', 2: 'shake', 3: 'nod+button', 4: 'ring' };
const VIEWS = ['live', 'history', 'card'];

const MAX_ENTRY_BYTES = 4000;      // glasses HIST_MAX_ENTRY_BYTES is 4096
const MAX_MESSAGE_BYTES = 3000;    // keep single Bluetooth messages small
const MAX_LOG = 400;

const encoder = new TextEncoder();

/** UTF-8 bytes of text, cut at maxBytes without splitting a character. */
export function utf8(text, maxBytes) {
  const bytes = encoder.encode(String(text ?? ''));
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 255); return this; }
  u16(v) { this.bytes.push(v & 255, (v >> 8) & 255); return this; }
  u32(v) { this.bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); return this; }
  raw(b) { for (const x of b) this.bytes.push(x); return this; }
  str8(text, max = 255) { const b = utf8(text, Math.min(max, 255)); return this.u8(b.length).raw(b); }
  str16(text, max = 4000) { const b = utf8(text, max); return this.u16(b.length).raw(b); }
  done() { return Uint8Array.from(this.bytes); }
}

// ---- encoders ---------------------------------------------------------------------

export const encodeHelloReq = () => new Writer().u8(CMD.HELLO_REQ).u8(PROTO_VERSION).done();
export const encodeReset = () => new Writer().u8(CMD.RESET).done();
export const encodeAskClear = (id) => new Writer().u8(CMD.ASK_CLEAR).u32(id).done();
export const encodeAnswerAck = (id, ok) => new Writer().u8(CMD.ANSWER_ACK).u32(id).u8(ok ? 1 : 0).done();
export const encodeNotice = (text) => new Writer().u8(CMD.NOTICE).str8(text, 63).done();

/** entries: [{ kind: number, text }]; firstSeq is the sequence number of entries[0]. */
export function encodeEntries(firstSeq, entries) {
  const w = new Writer().u8(CMD.ENTRIES).u32(firstSeq).u8(entries.length);
  for (const entry of entries) {
    const text = utf8(entry.text, MAX_ENTRY_BYTES);
    w.u8(entry.kind).u8(0).u16(text.length).raw(text);
  }
  return w.done();
}

export function encodeStatus({ state, sessions, left, right, waiting }) {
  return new Writer().u8(CMD.STATUS).u8(state).u8(Math.min(sessions, 255))
    .str8(left, 90).str8(right, 46).str16(waiting, 250).done();
}

export function encodeAsk({ id, risk, kind, seconds, title, project, detail }) {
  return new Writer().u8(CMD.ASK).u32(id).u8(risk === 'high' ? 1 : 0)
    .u8(kind === 'question' ? 1 : kind === 'listen' ? 2 : 0)
    .u16(Math.max(0, Math.min(seconds, 65535)))
    .str8(title, 95).str8(project, 63).str16(detail, 1000).done();
}

/** config: { raw: bool, wheelStep: 1..255, headPaging: bool, keymap: [[hiInput, action], ...] } */
export function encodeConfig({ raw = true, wheelStep = 1, headPaging = true, keymap = [] } = {}) {
  const w = new Writer().u8(CMD.CONFIG).u8(raw ? 1 : 0).u8(wheelStep).u8(headPaging ? 1 : 0).u8(keymap.length);
  for (const [input, action] of keymap) w.u8(input).u8(action);
  return w.done();
}

export const wrap = (cmd, body) => { const out = new Uint8Array(body.length + 1); out[0] = cmd; out.set(body, 1); return out; };

// ---- decoder -----------------------------------------------------------------------

export function decodeUp(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = data[0];
  try {
    switch (type) {
      case EVT.HELLO: {
        const count = data[11];
        const assetHashes = [];
        for (let i = 0; i < count; i += 1) assetHashes.push(view.getUint32(12 + i * 4, true));
        return {
          type: 'hello', version: data[1], width: view.getUint16(2, true), height: view.getUint16(4, true),
          rawInput: Boolean(data[6] & 1), lz4: Boolean(data[6] & 2), lastSeq: view.getUint32(7, true), assetHashes,
        };
      }
      case EVT.ANSWER:
        return { type: 'answer', id: view.getUint32(1, true), decision: DECISIONS[data[5]] || 'unknown', via: VIAS[data[6]] || 'glasses' };
      case EVT.NEED:
        return { type: 'need', fromSeq: view.getUint32(1, true) };
      case EVT.ASSET:
        return { type: 'asset', slot: data[1], result: view.getInt8(2) };
      case EVT.INPUT:
        return { type: 'input', input: data[1], source: data[2], action: data[3] };
      case EVT.VIEW:
        return { type: 'view', mode: VIEWS[data[1]] || 'live', top: view.getUint32(2, true), total: view.getUint32(6, true), unread: view.getUint32(10, true) };
      default:
        return { type: 'unknown', code: type };
    }
  } catch {
    return { type: 'malformed', code: type };
  }
}

// ---- relay state -> HUD content ----------------------------------------------------

const clean = (value) => String(value ?? '').replace(/[ \t]+/g, ' ').trim();

/** One relay feed event -> one history entry. */
export function eventToEntry(event, { showProject = false } = {}) {
  const project = showProject && event.project ? `[${event.project}] ` : '';
  const title = clean(event.title);
  const body = String(event.text ?? '').trim();
  switch (event.kind) {
    case 'prompt':
      return { kind: KIND.prompt, text: `${project}${body || title}` };
    case 'tool':
      return { kind: KIND.tool, text: `${project}${title}${body ? `: ${body}` : ''}` };
    case 'done':
      return { kind: KIND.done, text: `${project}${title || 'Finished'}${body ? `\n${body}` : ''}` };
    case 'error':
      return { kind: KIND.error, text: `${project}${title}${body ? `\n${body}` : ''}` };
    case 'notify':
      return { kind: KIND.notify, text: `${project}${title}${body ? `: ${body}` : ''}` };
    default:
      return { kind: KIND.system, text: `${project}${title}${body ? ` (${body})` : ''}` };
  }
}

function two(n) { return String(n).padStart(2, '0'); }

/** Header, state and "what is the agent waiting for" from screen.js state. */
export function statusFor(state, phoneNow, focusedAskValue) {
  const sessions = [...state.sessions.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  const latest = sessions[0];
  const date = new Date(phoneNow);
  const right = `${two(date.getHours())}:${two(date.getMinutes())}${sessions.length > 1 ? `  ${sessions.length} sessions` : ''}`;
  const left = `Claude${latest?.project ? ` · ${latest.project}` : ''}`;
  let code = STATE.idle;
  let waiting = '';
  const ask = focusedAskValue;
  if (state.connection !== 'online') {
    code = STATE.offline;
    waiting = state.connection === 'bad token' ? 'Relay rejected the token - fix it on the phone'
      : state.connection === 'not configured' ? 'Set the relay URL and token on the phone'
        : 'Relay offline - reconnecting';
  } else if (ask) {
    code = STATE.waiting;
    const more = state.pending.length > 1 ? `  (+${state.pending.length - 1})` : '';
    if (ask.kind === 'listen') waiting = `Claude is talking to you - click to reply${more}`;
    else if (ask.kind === 'question') waiting = `Question: ${clean(ask.title)}${more}`;
    else waiting = `Approve? ${clean(ask.title)}${ask.detail ? `: ${clean(ask.detail)}` : ''}${more}`;
  } else if (sessions.some((s) => s.state === 'waiting')) {
    code = STATE.waiting;
    const s = sessions.find((entry) => entry.state === 'waiting');
    waiting = `Needs you${s.project ? ` (${s.project})` : ''}: ${clean(s.last)}`;
  } else if (sessions.some((s) => s.state === 'working' || s.state === 'started')) {
    code = STATE.working;
  } else if (sessions.some((s) => s.state === 'error')) {
    code = STATE.error;
  }
  return { state: code, sessions: sessions.length, left, right, waiting };
}

// ---- the link ------------------------------------------------------------------------

export class NativeLink {
  /**
   * send(channel, Uint8Array) delivers to the glasses (gm.plugin.sendMessage).
   * log(text) is optional.
   */
  constructor({ send, log = () => {}, icons = ICONS, config = null }) {
    this.send = send;
    this.log = log;
    this.icons = icons;
    this.config = config;
    this.ready = false;           // glasses answered HELLO
    this.hello = null;
    this.entries = [];            // { seq, kind, text }
    this.nextSeq = 1;
    this.sentStatus = '';
    this.sentAsks = new Map();    // numeric id -> signature
    this.askIds = new Map();      // relay id -> numeric id
    this.relayIds = new Map();    // numeric id -> relay id
    this.nextAskId = 1;
    this.lastView = null;
    this.helloCount = 0;
  }

  out(bytes) {
    this.send(CH_DOWN, bytes);
  }

  start() {
    this.out(encodeHelloReq());
  }

  numericId(relayId) {
    let id = this.askIds.get(relayId);
    if (!id) {
      id = this.nextAskId;
      this.nextAskId = this.nextAskId >= 0xfffffff0 ? 1 : this.nextAskId + 1;
      this.askIds.set(relayId, id);
      this.relayIds.set(id, relayId);
    }
    return id;
  }

  /** Add relay feed events; sends them right away when the glasses are ready. */
  addEvents(events, { showProject = false } = {}) {
    const fresh = [];
    for (const event of events) {
      if (event.kind === 'session' && /ended/i.test(event.title || '') && !event.text) continue;
      const entry = { seq: this.nextSeq, ...eventToEntry(event, { showProject }) };
      this.nextSeq += 1;
      this.entries.push(entry);
      fresh.push(entry);
    }
    if (this.entries.length > MAX_LOG) this.entries.splice(0, this.entries.length - MAX_LOG);
    if (this.ready) this.sendEntries(fresh);
  }

  sendEntries(list) {
    let batch = [];
    let size = 6;
    const flush = () => {
      if (!batch.length) return;
      this.out(encodeEntries(batch[0].seq, batch));
      batch = [];
      size = 6;
    };
    for (const entry of list) {
      const bytes = Math.min(encoder.encode(entry.text).length, MAX_ENTRY_BYTES) + 4;
      if (batch.length && (size + bytes > MAX_MESSAGE_BYTES || batch.length >= 250)) flush();
      batch.push(entry);
      size += bytes;
    }
    flush();
  }

  sendFrom(seq) {
    this.sendEntries(this.entries.filter((entry) => entry.seq >= seq));
  }

  /** Push status and approval cards that changed. state is screen.js state. */
  sync(state, phoneNow, focusedAskValue) {
    if (!this.ready) return;
    const status = encodeStatus(statusFor(state, phoneNow, focusedAskValue));
    const key = status.join(',');
    if (key !== this.sentStatus) {
      this.sentStatus = key;
      this.out(status);
    }
    const serverNow = phoneNow + (state.serverOffset || 0);
    const live = new Set();
    for (const ask of state.pending) {
      const id = this.numericId(ask.id);
      live.add(id);
      const signature = `${ask.title}|${ask.detail}|${ask.risk}|${ask.kind}|${ask.expiresAt}`;
      if (this.sentAsks.get(id) === signature) continue;
      this.sentAsks.set(id, signature);
      this.out(encodeAsk({
        id, risk: ask.risk, kind: ask.kind, title: ask.title, project: ask.project, detail: ask.detail,
        seconds: Math.max(0, Math.ceil(((ask.expiresAt || serverNow) - serverNow) / 1000)),
      }));
    }
    for (const id of [...this.sentAsks.keys()]) {
      if (live.has(id)) continue;
      this.sentAsks.delete(id);
      this.out(encodeAskClear(id));
    }
  }

  /** Tell the glasses whether the relay accepted their answer. */
  ackAnswer(relayId, ok) {
    const id = this.askIds.get(relayId);
    if (!id) return;
    if (ok) this.sentAsks.delete(id);
    this.out(encodeAnswerAck(id, ok));
  }

  notice(text) {
    if (this.ready) this.out(encodeNotice(text));
  }

  /** Relay changed: drop history on both sides. */
  reset() {
    this.entries = [];
    this.sentStatus = '';
    this.sentAsks.clear();
    if (this.ready) this.out(encodeReset());
  }

  sendAssets(haveHashes = []) {
    let sent = 0;
    for (const [slotText, rows] of Object.entries(this.icons)) {
      const slot = Number(slotText);
      const { levels, width, height } = asciiToLevels(rows);
      const { hash, begin, tiles } = assetMessages({ slot, levels, width, height, tileRows: 16, lz4: this.hello?.lz4 !== false });
      if (haveHashes[slot] === hash) continue;  // only what the glasses lack or have stale
      this.out(wrap(CMD.ASSET_BEGIN, begin));
      for (const tile of tiles) this.out(wrap(CMD.ASSET_TILE, tile));
      sent += 1;
    }
    return sent;
  }

  /**
   * Handle a message from the glasses. Returns actions for the caller:
   * { type: 'answer', id (relay id), decision: 'allow'|'deny'|'talk', via }
   * { type: 'resync' } after a HELLO (caller should call sync() again).
   */
  onMessage(bytes) {
    const message = decodeUp(bytes);
    const actions = [];
    switch (message.type) {
      case 'hello': {
        const first = !this.ready;
        this.ready = true;
        this.hello = message;
        this.helloCount += 1;
        this.sentStatus = '';
        this.sentAsks.clear();
        const newest = this.entries.length ? this.entries[this.entries.length - 1].seq : 0;
        const oldest = this.entries.length ? this.entries[0].seq : 1;
        if (first || message.lastSeq > newest || (message.lastSeq > 0 && message.lastSeq + 1 < oldest)) {
          // New phone session, or the glasses hold history we no longer know: start clean.
          this.out(encodeReset());
          this.sendFrom(oldest);
        } else {
          this.sendFrom(message.lastSeq + 1);
        }
        if (this.config) this.out(encodeConfig(this.config));
        const icons = this.sendAssets(message.assetHashes);
        this.log(`Glasses plugin ready (raw input ${message.rawInput ? 'on' : 'off'}, ${icons} icons sent)`);
        actions.push({ type: 'resync' });
        break;
      }
      case 'need':
        this.log(`Glasses asked for history from #${message.fromSeq}`);
        if (this.entries.length && message.fromSeq < this.entries[0].seq) {
          this.out(encodeReset());
          this.sendFrom(this.entries[0].seq);
        } else {
          this.sendFrom(message.fromSeq);
        }
        break;
      case 'answer': {
        const relayId = this.relayIds.get(message.id);
        if (relayId) actions.push({ type: 'answer', id: relayId, decision: message.decision, via: message.via });
        break;
      }
      case 'asset':
        if (message.result < 0) this.log(`Icon ${message.slot} failed on the glasses (${message.result})`);
        break;
      case 'view':
        this.lastView = message;
        break;
      default:
        break;
    }
    return { message, actions };
  }
}
