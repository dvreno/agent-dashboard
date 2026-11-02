#!/usr/bin/env node
// Claude Code hook: forwards session activity to the MemoMind agent relay and,
// for PermissionRequest events, waits for an allow/deny answer from the glasses.
//
// Configuration (environment variables, e.g. via "env" in ~/.claude/settings.json):
//   MEMOMIND_RELAY_URL       https://memomind-agent-relay.<you>.workers.dev  (required)
//   MEMOMIND_RELAY_TOKEN     shared secret (or put it in ~/.claude/memomind/relay-token, chmod 600)
//   MEMOMIND_ASK_TIMEOUT     seconds to wait for a glasses answer (default 90)
//   MEMOMIND_TIMEOUT_ACTION  "deny" (default) or "prompt" (fall back to the normal terminal prompt)
//   MEMOMIND_DISABLED        set to 1 to turn the hook off without editing settings
//
// Safety: this hook never approves anything on its own. If the relay is
// unreachable or misconfigured it prints nothing, so Claude Code shows its
// normal permission prompt. Status events never block Claude.

import { toAsk, toFeedEvent, permissionOutput } from './lib.mjs';
import { createRelay, relayConfig } from './relay.mjs';

const config = relayConfig();
const relay = createRelay(config);
const ASK_TIMEOUT_S = Math.min(Math.max(Number(process.env.MEMOMIND_ASK_TIMEOUT) || 90, 10), 590);
const TIMEOUT_ACTION = process.env.MEMOMIND_TIMEOUT_ACTION === 'prompt' ? 'prompt' : 'deny';

function log(message) {
  if (process.env.MEMOMIND_DEBUG) process.stderr.write(`[memomind-hook] ${message}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handlePermission(input) {
  const { timeoutMs, ...ask } = toAsk(input, ASK_TIMEOUT_S * 1000);
  const result = await relay.askAndWait(ask, ASK_TIMEOUT_S, { log });
  if (result.state === 'allow') return permissionOutput('allow');
  if (result.state === 'deny') {
    return permissionOutput('deny', `Denied from MemoMind glasses${result.reason ? `: ${result.reason}` : ''}.`);
  }
  if (TIMEOUT_ACTION === 'prompt') return null;
  return permissionOutput('deny', `No answer from MemoMind glasses within ${ASK_TIMEOUT_S}s, so the action was denied. Ask the user to retry if needed.`);
}

async function main() {
  if (process.env.MEMOMIND_DISABLED === '1' || !config.url || !config.token) return;
  const input = await readStdin();

  if (input.hook_event_name === 'PermissionRequest') {
    const output = await handlePermission(input);
    if (output) process.stdout.write(JSON.stringify(output));
    return;
  }

  const event = toFeedEvent(input);
  if (event) await relay.postEvent(event);
}

main().catch((error) => {
  // Never break Claude Code: no output means "no decision" / normal flow.
  log(error.stack || String(error));
  process.exitCode = 0;
});
