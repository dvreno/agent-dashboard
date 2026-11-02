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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toAsk, toFeedEvent, permissionOutput } from './lib.mjs';

// The token can come from MEMOMIND_RELAY_TOKEN, or (preferred, keeps it out of
// settings.json) from a private file: MEMOMIND_RELAY_TOKEN_FILE, default
// ~/.claude/memomind/relay-token.
function readToken() {
  if (process.env.MEMOMIND_RELAY_TOKEN) return process.env.MEMOMIND_RELAY_TOKEN.trim();
  const file = process.env.MEMOMIND_RELAY_TOKEN_FILE || join(homedir(), '.claude', 'memomind', 'relay-token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const RELAY = (process.env.MEMOMIND_RELAY_URL || '').replace(/\/+$/, '');
const TOKEN = readToken();
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

async function relay(method, pathname, body, timeoutMs) {
  const response = await fetch(`${RELAY}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}`);
  return data;
}

async function handlePermission(input) {
  const deadline = Date.now() + ASK_TIMEOUT_S * 1000;
  const { ask } = await relay('POST', '/v1/asks', toAsk(input, ASK_TIMEOUT_S * 1000), 8000);
  log(`ask ${ask.id} created (${ask.risk})`);

  let current = ask;
  while (current.state === 'pending' && Date.now() < deadline) {
    const wait = Math.min(25_000, Math.max(deadline - Date.now(), 0));
    try {
      ({ ask: current } = await relay('GET', `/v1/asks/${ask.id}?wait=${wait}`, null, wait + 10_000));
    } catch (error) {
      log(`poll failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (current.state === 'allow') return permissionOutput('allow');
  if (current.state === 'deny') {
    return permissionOutput('deny', `Denied from MemoMind glasses${current.reason ? `: ${current.reason}` : ''}.`);
  }
  // Timed out or cancelled: withdraw the card from the glasses.
  await relay('POST', `/v1/asks/${ask.id}/cancel`, {}, 5000).catch(() => {});
  if (TIMEOUT_ACTION === 'prompt') return null;
  return permissionOutput('deny', `No answer from MemoMind glasses within ${ASK_TIMEOUT_S}s, so the action was denied. Ask the user to retry if needed.`);
}

async function main() {
  if (process.env.MEMOMIND_DISABLED === '1' || !RELAY || !TOKEN) return;
  const input = await readStdin();

  if (input.hook_event_name === 'PermissionRequest') {
    const output = await handlePermission(input);
    if (output) process.stdout.write(JSON.stringify(output));
    return;
  }

  const event = toFeedEvent(input);
  if (event) await relay('POST', '/v1/events', event, 4000);
}

main().catch((error) => {
  // Never break Claude Code: no output means "no decision" / normal flow.
  log(error.stack || String(error));
  process.exitCode = 0;
});
