// End-to-end check of the remote MCP connector against a running relay.
// Plays Claude Duet (MCP client over HTTP) and the phone (answers asks).
//
//   RELAY_URL=http://127.0.0.1:8787 RELAY_TOKEN=... MCP_SECRET=... node test/duet-connector-e2e.mjs

import assert from 'node:assert/strict';
import { createRelayClient } from '../phone/relay-client.js';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const { RELAY_TOKEN, MCP_SECRET } = process.env;
assert.ok(RELAY_TOKEN && MCP_SECRET, 'set RELAY_TOKEN and MCP_SECRET');
const phone = createRelayClient({ url: RELAY, token: RELAY_TOKEN });
const endpoint = `${RELAY}/mcp/${MCP_SECRET}`;

let nextId = 1;
async function rpc(method, params, url = endpoint) {
  const id = nextId++;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).body.result;

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log('ok');
}

await step('wrong secret looks like a 404', async () => {
  assert.equal((await rpc('ping', {}, `${RELAY}/mcp/not-the-secret-not-the-secret`)).status, 404);
});

await step('initialize + notifications/initialized + tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'duet-e2e', version: '0' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'memomind-glasses-remote');
  const note = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const list = await rpc('tools/list', {});
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['glasses_notify', 'glasses_ask', 'glasses_get_answer']);
  assert.equal((await fetch(endpoint)).status, 405, 'GET (SSE) is not offered');
});

await step('glasses_notify lands in the phone feed', async () => {
  const { seq } = await phone.check();
  const result = await tool('glasses_notify', { title: 'Morning brief ready', message: '3 emails need replies', level: 'info' });
  assert.equal(result.content[0].text, 'Shown on the glasses.');
  const feed = await phone.feed(seq, 0);
  const event = feed.events.find((e) => e.title === 'Morning brief ready');
  assert.ok(event, 'event missing from feed');
  assert.equal(event.session, 'duet');
});

await step('glasses_ask → phone nods → "yes"', async () => {
  const { seq } = await phone.check();
  const pending = tool('glasses_ask', { question: 'Send the reply to Sam?', detail: 'Draft: "Thursday works, see you then."' });
  let ask;
  for (let i = 0; i < 20 && !ask; i += 1) ask = (await phone.feed(seq, 2000)).pending.find((a) => a.title === 'Send the reply to Sam?');
  assert.ok(ask, 'question never reached the phone');
  assert.equal(ask.kind, 'question');
  await phone.answer(ask.id, 'allow', 'nod');
  assert.equal((await pending).content[0].text, 'yes');
});

await step('glasses_ask unanswered → pending with ask_id → shake → glasses_get_answer "no"', async () => {
  const first = await tool('glasses_ask', { question: 'Archive 40 newsletters?' });
  const match = /ask_id: ([\w-]+)/.exec(first.content[0].text);
  assert.ok(match, `expected pending, got: ${first.content[0].text}`);
  await phone.answer(match[1], 'deny', 'shake');
  assert.equal((await tool('glasses_get_answer', { ask_id: match[1] })).content[0].text, 'no');
});

console.log('\nAll Duet connector checks passed.');
