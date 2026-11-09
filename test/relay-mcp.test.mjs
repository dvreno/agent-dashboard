import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, SUPPORTED_PROTOCOLS, TOOLS, WAIT_PER_CALL_MS } from '../relay/src/mcp.js';

function fakeHub({ answerWith = 'pending' } = {}) {
  const calls = [];
  const asks = new Map();
  return {
    calls,
    asks,
    async postEvent(event) { calls.push(['postEvent', event]); return { event }; },
    async createAsk(ask) {
      calls.push(['createAsk', ask]);
      const created = { id: `ask-${asks.size + 1}`, state: 'pending', ...ask };
      asks.set(created.id, created);
      return { ask: created };
    },
    async waitAsk(id, waitMs) {
      calls.push(['waitAsk', id, waitMs]);
      const ask = asks.get(id);
      if (!ask) { const error = new Error('ask not found'); error.status = 404; throw error; }
      if (ask.state === 'pending' && answerWith !== 'pending') ask.state = answerWith;
      return { ask };
    },
  };
}

const call = (handler, name, args, id = 1) => handler.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize negotiates a supported protocol version and advertises tools', async () => {
  const handler = createMcpHandler({ hub: fakeHub() });
  const known = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(known.result.protocolVersion, '2025-03-26');
  assert.ok(known.result.capabilities.tools);
  assert.match(known.result.instructions, /nodding/);
  const unknown = await handler.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
});

test('tools/list returns the three glasses tools with schemas', async () => {
  const { result } = await createMcpHandler({ hub: fakeHub() }).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['glasses_notify', 'glasses_ask', 'glasses_get_answer']);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.type, 'object');
});

test('notifications get no response; unknown methods get -32601', async () => {
  const handler = createMcpHandler({ hub: fakeHub() });
  assert.equal(await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handler.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handler.handle({ id: 4, method: 'ping' })).error.code, -32600);
});

test('glasses_notify posts a clipped feed event labelled as Duet', async () => {
  const hub = fakeHub();
  const handler = createMcpHandler({ hub });
  const response = await call(handler, 'glasses_notify', { title: 'x'.repeat(200), message: 'Invoice from Acme is due', level: 'done' });
  assert.equal(response.result.content[0].text, 'Shown on the glasses.');
  const [, event] = hub.calls[0];
  assert.equal(event.kind, 'done');
  assert.equal(event.session, 'duet');
  assert.equal(event.title.length, 80);
});

test('glasses_notify without a title is a tool error, not a crash', async () => {
  const response = await call(createMcpHandler({ hub: fakeHub() }), 'glasses_notify', {});
  assert.equal(response.result.isError, true);
});

test('glasses_ask returns yes when answered with a nod', async () => {
  const hub = fakeHub({ answerWith: 'allow' });
  const response = await call(createMcpHandler({ hub }), 'glasses_ask', { question: 'Pay the Acme invoice?', risk: 'high' });
  assert.equal(response.result.content[0].text, 'yes');
  const [, ask] = hub.calls[0];
  assert.equal(ask.kind, 'question');
  assert.equal(ask.risk, 'high');
  assert.equal(ask.timeoutMs, 300_000);
  assert.deepEqual(hub.calls[1], ['waitAsk', 'ask-1', WAIT_PER_CALL_MS]);
});

test('glasses_ask returns pending with an ask_id, and glasses_get_answer resolves it later', async () => {
  const hub = fakeHub();
  const handler = createMcpHandler({ hub });
  const first = await call(handler, 'glasses_ask', { question: 'Reply to Sam now?', expires_in_seconds: 9999 });
  assert.match(first.result.content[0].text, /^pending \(ask_id: ask-1\)/);
  assert.equal(hub.calls[0][1].timeoutMs, 600_000, 'expiry is capped at 10 minutes');
  hub.asks.get('ask-1').state = 'deny';
  const second = await call(handler, 'glasses_get_answer', { ask_id: 'ask-1' }, 2);
  assert.equal(second.result.content[0].text, 'no');
});

test('expired or unknown asks read as "no answer", never yes', async () => {
  const hub = fakeHub();
  const handler = createMcpHandler({ hub });
  await call(handler, 'glasses_ask', { question: 'Delete old drafts?' });
  hub.asks.get('ask-1').state = 'expired';
  assert.match((await call(handler, 'glasses_get_answer', { ask_id: 'ask-1' })).result.content[0].text, /^no answer/);
  assert.match((await call(handler, 'glasses_get_answer', { ask_id: 'missing' })).result.content[0].text, /^no answer/);
});

test('relay failures surface as tool errors', async () => {
  const hub = fakeHub();
  hub.postEvent = async () => { throw new Error('relay down'); };
  const response = await call(createMcpHandler({ hub }), 'glasses_notify', { title: 'hi' });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /relay down/);
});
