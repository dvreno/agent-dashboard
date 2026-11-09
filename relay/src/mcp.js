// Remote MCP endpoint (Streamable HTTP, JSON responses) so cloud agents such as
// Claude Duet, or the Claude apps, can reach the glasses through a custom
// connector. Pure logic: the Worker passes in a small `hub` client, which keeps
// this file unit-testable in Node.
//
// Tools:
//   glasses_notify      show a short message on the HUD
//   glasses_ask         ask a yes/no question (nod = yes, shake = no); waits up
//                       to ~40 s, then returns an ask_id if still unanswered
//   glasses_get_answer  keep waiting for a pending glasses_ask

export const SERVER_INFO = { name: 'memomind-glasses-remote', version: '0.1.0' };
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const WAIT_PER_CALL_MS = 40_000;       // stay well inside typical tool-call timeouts
export const DEFAULT_ASK_TTL_S = 300;
export const MAX_ASK_TTL_S = 600;

const INSTRUCTIONS = [
  'The user may be wearing MemoMind smart glasses with a small monochrome heads-up display (about 6 short lines).',
  'Use glasses_notify for brief, glanceable updates: something needs their attention, a task finished, a check-in summary.',
  'Keep titles under ~40 characters and messages to one or two short sentences. Do not send more than a few per hour.',
  'Use glasses_ask only for genuine yes/no decisions; the user answers by nodding (yes) or shaking their head (no).',
  'If glasses_ask returns pending, call glasses_get_answer with the ask_id to keep waiting.',
  'A glasses answer never replaces any confirmation your own app requires, and "no answer" always means not approved.',
].join(' ');

export const TOOLS = [
  {
    name: 'glasses_notify',
    description: 'Show a short message on the user\'s MemoMind glasses HUD. Returns immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Headline, ideally under 40 characters.' },
        message: { type: 'string', description: 'Optional one or two short sentences of detail.' },
        level: { type: 'string', enum: ['info', 'done', 'error'], description: 'info (default), done (task finished), or error.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Show on glasses', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'glasses_ask',
    description: 'Ask the user a yes/no question on their MemoMind glasses (nod = yes, shake = no). '
      + 'Waits up to ~40 seconds. Returns "yes", "no", "no answer", or "pending" with an ask_id to pass to glasses_get_answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The yes/no question, ideally under 60 characters.' },
        detail: { type: 'string', description: 'Optional context shown under the question (max ~300 characters).' },
        risk: { type: 'string', enum: ['normal', 'high'], description: 'high requires a nod plus a button press to say yes.' },
        expires_in_seconds: { type: 'number', description: `How long the question stays on the glasses (default ${DEFAULT_ASK_TTL_S}, max ${MAX_ASK_TTL_S}).` },
      },
      required: ['question'],
      additionalProperties: false,
    },
    annotations: { title: 'Ask on glasses', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'glasses_get_answer',
    description: 'Keep waiting (up to ~40 seconds) for the answer to a pending glasses_ask. '
      + 'Returns "yes", "no", "no answer", or "pending" again.',
    inputSchema: {
      type: 'object',
      properties: { ask_id: { type: 'string', description: 'The ask_id returned by glasses_ask.' } },
      required: ['ask_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Check glasses answer', readOnlyHint: true, openWorldHint: false },
  },
];

export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function describeAsk(ask) {
  if (ask.state === 'allow') return textResult('yes');
  if (ask.state === 'deny') return textResult('no');
  if (ask.state === 'pending') {
    return textResult(`pending (ask_id: ${ask.id}). The question is still on the glasses; call glasses_get_answer with this ask_id to keep waiting.`);
  }
  return textResult('no answer (the user did not respond in time; treat this as not approved)');
}

// hub: { postEvent(event), createAsk(ask), waitAsk(id, waitMs) } — each returns the relay's JSON body.
export function createMcpHandler({ hub, source = 'duet', project = 'Claude' }) {
  async function callTool(name, args = {}) {
    if (name === 'glasses_notify') {
      if (typeof args.title !== 'string' || !args.title.trim()) return textResult('title is required', true);
      const level = args.level === 'done' || args.level === 'error' ? args.level : 'notify';
      await hub.postEvent({ kind: level, session: source, project, title: clip(args.title, 80), text: clip(args.message, 300) });
      return textResult('Shown on the glasses.');
    }
    if (name === 'glasses_ask') {
      if (typeof args.question !== 'string' || !args.question.trim()) return textResult('question is required', true);
      const ttl = Math.min(Math.max(Number(args.expires_in_seconds) || DEFAULT_ASK_TTL_S, 15), MAX_ASK_TTL_S);
      const { ask } = await hub.createAsk({
        kind: 'question',
        session: source,
        project,
        title: clip(args.question, 80),
        detail: clip(args.detail, 300),
        risk: args.risk === 'high' ? 'high' : 'normal',
        timeoutMs: ttl * 1000,
      });
      const { ask: result } = await hub.waitAsk(ask.id, WAIT_PER_CALL_MS);
      return describeAsk(result);
    }
    if (name === 'glasses_get_answer') {
      if (typeof args.ask_id !== 'string' || !args.ask_id) return textResult('ask_id is required', true);
      try {
        const { ask } = await hub.waitAsk(args.ask_id, WAIT_PER_CALL_MS);
        return describeAsk(ask);
      } catch (error) {
        if (error.status === 404) return textResult('no answer (that question has expired)');
        throw error;
      }
    }
    return textResult(`Unknown tool: ${name}`, true);
  }

  // Returns a JSON-RPC response object, or null for notifications.
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params = {} } = message;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments || {}) };
        default:
          if (!isRequest) return null; // notifications/initialized, notifications/cancelled, …
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (error) {
      if (!isRequest) return null;
      if (method === 'tools/call') return { jsonrpc: '2.0', id, result: textResult(`Glasses relay error: ${error.message}`, true) };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } };
    }
  }

  return { handle };
}
