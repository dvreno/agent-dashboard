#!/usr/bin/env node
// MemoMind glasses MCP server (stdio, dependency-free).
//
// Gives any MCP-capable agent (Claude Code, etc.) two tools:
//   glasses_notify  show a short message on the wearer's MemoMind HUD
//   glasses_ask     ask the wearer a yes/no question; nod = yes, shake = no
//
// Uses the same relay and configuration as memomind-hook.mjs:
//   MEMOMIND_RELAY_URL, MEMOMIND_RELAY_TOKEN or ~/.claude/memomind/relay-token
//
// Register with Claude Code (user scope):
//   claude mcp add memomind --scope user \
//     -e MEMOMIND_RELAY_URL=https://memomind-agent-relay.<you>.workers.dev \
//     -- node ~/.claude/memomind/memomind-mcp.mjs

import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { redact, truncate } from './lib.mjs';
import { createRelay, relayConfig } from './relay.mjs';

export const SERVER_INFO = { name: 'memomind-glasses', version: '0.2.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const DEFAULT_ASK_TIMEOUT_S = 120;
const MAX_ASK_TIMEOUT_S = 590;

const INSTRUCTIONS = [
  'The user may be wearing MemoMind smart glasses with a small monochrome heads-up display.',
  'Use glasses_notify for short, glanceable updates the user would want while away from the screen',
  '(long task finished, tests failing, blocked and waiting). Keep titles under ~40 characters.',
  'Use glasses_ask only for genuine yes/no decisions; the user answers by nodding or shaking their head.',
  'If glasses_ask returns "no answer", assume the user is not available and do not proceed with',
  'anything that needed their approval.',
].join(' ');

export const TOOLS = [
  {
    name: 'glasses_notify',
    description: 'Show a short message on the user\'s MemoMind glasses HUD. Fire-and-forget; returns immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Headline, ideally under 40 characters.' },
        message: { type: 'string', description: 'Optional one or two sentences of detail.' },
        level: { type: 'string', enum: ['info', 'done', 'error'], description: 'info (default), done (task finished), or error.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'glasses_ask',
    description: 'Ask the user a yes/no question on their MemoMind glasses and wait for the answer (nod = yes, shake = no). '
      + 'Returns "yes", "no", or "no answer" if they did not respond in time.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The yes/no question, ideally under 60 characters.' },
        detail: { type: 'string', description: 'Optional context shown under the question (max ~300 characters).' },
        risk: { type: 'string', enum: ['normal', 'high'], description: 'high requires a nod plus a button press to say yes.' },
        timeout_seconds: { type: 'number', description: `How long to wait (default ${DEFAULT_ASK_TIMEOUT_S}, max ${MAX_ASK_TIMEOUT_S}).` },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

export function createServer({ relay, configured, cwd = process.cwd() }) {
  const project = basename(cwd);
  const inflight = new Map(); // request id -> AbortController

  async function callTool(name, args = {}, id) {
    if (!configured) {
      return text('MemoMind relay is not configured (set MEMOMIND_RELAY_URL and the relay token).', true);
    }
    if (name === 'glasses_notify') {
      const level = ['done', 'error'].includes(args.level) ? args.level : 'notify';
      await relay.postEvent({
        kind: level,
        session: 'mcp',
        project,
        title: truncate(redact(args.title), 80),
        text: truncate(redact(args.message || ''), 300),
      });
      return text('Shown on the glasses.');
    }
    if (name === 'glasses_ask') {
      if (!args.question || typeof args.question !== 'string') return text('question is required', true);
      const timeoutS = Math.min(Math.max(Number(args.timeout_seconds) || DEFAULT_ASK_TIMEOUT_S, 10), MAX_ASK_TIMEOUT_S);
      const controller = new AbortController();
      inflight.set(id, controller);
      try {
        const result = await relay.askAndWait({
          kind: 'question',
          session: 'mcp',
          project,
          title: truncate(redact(args.question), 80),
          detail: truncate(redact(args.detail || ''), 300),
          risk: args.risk === 'high' ? 'high' : 'normal',
        }, timeoutS, { signal: controller.signal });
        if (result.state === 'allow') return text('yes');
        if (result.state === 'deny') return text('no');
        return text(`no answer (the user did not respond within ${timeoutS}s; treat this as not approved)`);
      } finally {
        inflight.delete(id);
      }
    }
    return text(`Unknown tool: ${name}`, true);
  }

  // Returns a JSON-RPC response object, or null for notifications.
  async function handle(message) {
    const { id, method, params = {} } = message;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            },
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments, id) };
        case 'notifications/cancelled':
          inflight.get(params.requestId)?.abort();
          return null;
        default:
          if (!isRequest) return null; // ignore unknown notifications (e.g. notifications/initialized)
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (error) {
      if (!isRequest) return null;
      if (method === 'tools/call') return { jsonrpc: '2.0', id, result: text(`MemoMind relay error: ${error.message}`, true) };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } };
    }
  }

  return { handle };
}

// stdio transport: newline-delimited JSON-RPC.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = relayConfig();
  const server = createServer({ relay: createRelay(config), configured: Boolean(config.url && config.token) });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    // Handle concurrently: a long glasses_ask must not block pings or other calls.
    void server.handle(message).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}
