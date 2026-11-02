// End-to-end check against a running relay (local `wrangler dev` or deployed).
// Spawns the real hook script with Claude Code-shaped payloads and plays the
// phone's role using the phone plugin's own relay client.
//
//   RELAY_URL=http://127.0.0.1:8787 RELAY_TOKEN=... node test/e2e.mjs

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRelayClient } from '../phone/relay-client.js';

const URL_ = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.RELAY_TOKEN;
assert.ok(TOKEN, 'set RELAY_TOKEN');
const HOOK = fileURLToPath(new URL('../hook/memomind-hook.mjs', import.meta.url));
const phone = createRelayClient({ url: URL_, token: TOKEN });

function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, MEMOMIND_RELAY_URL: URL_, MEMOMIND_RELAY_TOKEN: TOKEN, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const base = { session_id: 'e2e-session-0001', cwd: '/Users/me/memomind-plugins', transcript_path: '/tmp/x' };
const permission = (command) => ({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } });

async function waitForAsk(since, predicate) {
  for (let i = 0; i < 20; i += 1) {
    const feed = await phone.feed(since, 2000);
    const ask = feed.pending.find((item) => item.seq > since && predicate(item)); // ignore leftovers from earlier runs
    if (ask) return ask;
  }
  throw new Error('ask never appeared');
}

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log('ok');
}

const start = (await phone.check()).seq;

await step('auth: wrong token is rejected', async () => {
  const bad = createRelayClient({ url: URL_, token: 'wrong-token-wrong-token-1234' });
  await assert.rejects(bad.check(), (error) => error.status === 401);
});

await step('status events reach the feed (SessionStart, PostToolUse, Stop) with secrets redacted', async () => {
  await runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'export KEY=sk-ant-api03-FAKEfakeFAKEfake1234 && npm test' } });
  await runHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'All 31 tests pass.' });
  const feed = await phone.feed(start, 0);
  const kinds = feed.events.map((event) => event.kind);
  assert.deepEqual(kinds.slice(-3), ['session', 'tool', 'done']);
  assert.ok(!JSON.stringify(feed.events).includes('FAKEfake'), 'secret leaked to relay');
  assert.equal(feed.events.at(-1).project, 'memomind-plugins');
});

await step('nod on the glasses → hook prints allow', async () => {
  const { seq } = await phone.check();
  const hook = runHook(permission('npm run build'));
  const ask = await waitForAsk(seq, (item) => item.detail === 'npm run build');
  assert.equal(ask.risk, 'normal');
  await phone.answer(ask.id, 'allow', 'nod');
  const result = await hook;
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

await step('shake → hook prints deny with a message for Claude', async () => {
  const { seq } = await phone.check();
  const hook = runHook(permission('git push --force origin main'));
  const ask = await waitForAsk(seq, (item) => item.detail.startsWith('git push --force'));
  assert.equal(ask.risk, 'high');
  await phone.answer(ask.id, 'deny', 'shake');
  const output = JSON.parse((await hook).stdout);
  assert.equal(output.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(output.hookSpecificOutput.decision.message, /Denied from MemoMind glasses/);
});

await step('no answer → denied after timeout, card withdrawn', async () => {
  const { seq } = await phone.check();
  const result = await runHook(permission('echo timeout-test'), { MEMOMIND_ASK_TIMEOUT: '10' });
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.decision.behavior, 'deny');
  const feed = await phone.feed(seq, 0);
  assert.ok(!feed.pending.some((item) => item.detail === 'echo timeout-test'), 'card should be gone');
});

await step('MEMOMIND_TIMEOUT_ACTION=prompt → no output (normal terminal prompt)', async () => {
  const result = await runHook(permission('echo prompt-test'), { MEMOMIND_ASK_TIMEOUT: '10', MEMOMIND_TIMEOUT_ACTION: 'prompt' });
  assert.equal(result.stdout, '');
});

await step('relay unreachable → no output, exit 0 (never auto-approves)', async () => {
  const result = await runHook(permission('ls'), { MEMOMIND_RELAY_URL: 'http://127.0.0.1:9' });
  assert.equal(result.stdout, '');
  assert.equal(result.code, 0);
});

await step('second answer to the same ask is rejected (409)', async () => {
  const { seq } = await phone.check();
  const hook = runHook(permission('echo double'));
  const ask = await waitForAsk(seq, (item) => item.detail === 'echo double');
  await phone.answer(ask.id, 'deny', 'phone');
  await assert.rejects(phone.answer(ask.id, 'allow', 'nod'), (error) => error.status === 409);
  await hook;
});

// ---- MCP server over real stdio ---------------------------------------------

function startMcp() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../hook/memomind-mcp.mjs', import.meta.url))], {
    env: { ...process.env, MEMOMIND_RELAY_URL: URL_, MEMOMIND_RELAY_TOKEN: TOKEN },
  });
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  return {
    request(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve) => waiting.set(id, resolve));
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close: () => child.kill(),
  };
}

await step('MCP: initialize + tools/list over stdio', async () => {
  const mcp = startMcp();
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'memomind-glasses');
  mcp.notify('notifications/initialized');
  const list = await mcp.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['glasses_notify', 'glasses_ask']);
  mcp.close();
});

await step('MCP: glasses_notify reaches the feed', async () => {
  const { seq } = await phone.check();
  const mcp = startMcp();
  await mcp.request('initialize', { protocolVersion: '2025-06-18' });
  const result = await mcp.request('tools/call', { name: 'glasses_notify', arguments: { title: 'e2e notify', message: 'hello HUD', level: 'done' } });
  assert.equal(result.result.content[0].text, 'Shown on the glasses.');
  const feed = await phone.feed(seq, 0);
  assert.ok(feed.events.some((event) => event.title === 'e2e notify' && event.kind === 'done'));
  mcp.close();
});

await step('MCP: glasses_ask → question card → nod → "yes"', async () => {
  const { seq } = await phone.check();
  const mcp = startMcp();
  await mcp.request('initialize', { protocolVersion: '2025-06-18' });
  const pending = mcp.request('tools/call', { name: 'glasses_ask', arguments: { question: 'e2e: ship it?', timeout_seconds: 30 } });
  const ask = await waitForAsk(seq, (item) => item.title === 'e2e: ship it?');
  assert.equal(ask.kind, 'question');
  await phone.answer(ask.id, 'allow', 'nod');
  assert.equal((await pending).result.content[0].text, 'yes');
  mcp.close();
});

await step('MCP: cancelling a glasses_ask withdraws the card', async () => {
  const { seq } = await phone.check();
  const mcp = startMcp();
  await mcp.request('initialize', { protocolVersion: '2025-06-18' });
  const pending = mcp.request('tools/call', { name: 'glasses_ask', arguments: { question: 'e2e: cancel me', timeout_seconds: 60 } });
  await waitForAsk(seq, (item) => item.title === 'e2e: cancel me');
  mcp.notify('notifications/cancelled', { requestId: 2 });
  assert.match((await pending).result.content[0].text, /^no answer/);
  const feed = await phone.feed(seq, 0);
  assert.ok(!feed.pending.some((item) => item.title === 'e2e: cancel me'), 'card should be withdrawn');
  mcp.close();
});

console.log('\nAll end-to-end checks passed.');
