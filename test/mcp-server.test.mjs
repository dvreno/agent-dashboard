import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, TOOLS } from '../hook/memomind-mcp.mjs';

function fakeRelay({ answer = 'allow', fail = false } = {}) {
  const calls = { events: [], asks: [] };
  return {
    calls,
    async postEvent(event) {
      if (fail) throw new Error('503 relay down');
      calls.events.push(event);
    },
    async askAndWait(ask, timeoutS, { signal } = {}) {
      calls.asks.push({ ask, timeoutS });
      if (answer === 'hang') {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { state: 'cancelled' };
      }
      return { state: answer };
    },
  };
}

const call = (server, name, args, id = 1) => server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const textOf = (response) => response.result.content[0].text;

test('initialize echoes the client protocol version and advertises tools', async () => {
  const server = createServer({ relay: fakeRelay(), configured: true });
  const response = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(response.result.protocolVersion, '2025-03-26');
  assert.ok(response.result.capabilities.tools);
  assert.equal(response.result.serverInfo.name, 'memomind-glasses');
});

test('notifications get no response; unknown requests get -32601', async () => {
  const server = createServer({ relay: fakeRelay(), configured: true });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const response = await server.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(response.error.code, -32601);
});

test('tools/list returns both tools with schemas', async () => {
  const server = createServer({ relay: fakeRelay(), configured: true });
  const { result } = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['glasses_notify', 'glasses_ask']);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.type, 'object');
});

test('glasses_notify posts a redacted event tagged with the project', async () => {
  const relay = fakeRelay();
  const server = createServer({ relay, configured: true, cwd: '/Users/me/my-project' });
  const response = await call(server, 'glasses_notify', { title: 'Deploy done', message: 'key sk-ant-api03-FAKEfakeFAKEfake1234', level: 'done' });
  assert.equal(textOf(response), 'Shown on the glasses.');
  const [event] = relay.calls.events;
  assert.equal(event.kind, 'done');
  assert.equal(event.project, 'my-project');
  assert.ok(!event.text.includes('FAKEfake'));
});

test('glasses_ask maps allow/deny/expired to yes/no/no answer', async () => {
  for (const [answer, expected] of [['allow', 'yes'], ['deny', 'no'], ['expired', /^no answer/]]) {
    const relay = fakeRelay({ answer });
    const server = createServer({ relay, configured: true });
    const response = await call(server, 'glasses_ask', { question: 'Merge PR #2?', timeout_seconds: 30 });
    if (expected instanceof RegExp) assert.match(textOf(response), expected);
    else assert.equal(textOf(response), expected);
    assert.equal(relay.calls.asks[0].ask.kind, 'question');
    assert.equal(relay.calls.asks[0].timeoutS, 30);
  }
});

test('glasses_ask clamps timeout and passes risk', async () => {
  const relay = fakeRelay();
  const server = createServer({ relay, configured: true });
  await call(server, 'glasses_ask', { question: 'Force push?', risk: 'high', timeout_seconds: 99999 });
  assert.equal(relay.calls.asks[0].timeoutS, 590);
  assert.equal(relay.calls.asks[0].ask.risk, 'high');
});

test('notifications/cancelled aborts a waiting glasses_ask', async () => {
  const relay = fakeRelay({ answer: 'hang' });
  const server = createServer({ relay, configured: true });
  const pending = call(server, 'glasses_ask', { question: 'Still there?' }, 42);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } });
  assert.match(textOf(await pending), /^no answer/);
});

test('relay errors and missing config become tool errors, not crashes', async () => {
  const down = createServer({ relay: fakeRelay({ fail: true }), configured: true });
  const response = await call(down, 'glasses_notify', { title: 'x' });
  assert.equal(response.result.isError, true);
  assert.match(textOf(response), /relay error/);

  const unconfigured = createServer({ relay: fakeRelay(), configured: false });
  assert.equal((await call(unconfigured, 'glasses_ask', { question: 'x' })).result.isError, true);
});
