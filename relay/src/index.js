// Cloudflare Worker entry: authenticates requests and forwards them to a single
// Durable Object ("Hub") that holds the feed and pending asks.
//
// Routes (all JSON, all except /health need `Authorization: Bearer <RELAY_TOKEN>`):
//   GET  /health
//   POST /v1/events                 agent → feed event
//   POST /v1/asks                   agent → create yes/no ask
//   GET  /v1/asks/:id?wait=ms       agent → long-poll for the decision
//   POST /v1/asks/:id/answer        phone → { decision: allow|deny, via }
//   POST /v1/asks/:id/cancel        agent → withdraw an ask
//   POST /v1/asks/:id/attach        agent → { clipId } attach audio to a pending ask
//   GET  /v1/feed?since=seq&wait=ms phone → long-poll for new events + pending asks
//   POST /v1/clips                  either → raw audio body (≤1.5 MB) → { clip: { id, type, size } }
//   GET  /v1/clips/:id              either → the audio bytes (kept 15 minutes)
//
// Remote MCP connector (for Claude Duet / Claude apps custom connectors):
//   POST /mcp/<MCP_SECRET>          JSON-RPC over Streamable HTTP (JSON responses)
//   The secret in the path is the credential; it is separate from RELAY_TOKEN.

import { CLIP_TTL_MS, Hub, HttpError, MAX_CLIP_BYTES } from './hub.js';
import { createMcpHandler } from './mcp.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(bytes);
}

// Constant-time comparison of fixed-length digests.
export async function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname.startsWith('/mcp/')) return handleMcp(request, env, url);
    if (!url.pathname.startsWith('/v1/')) return json(404, { error: 'not found' });

    if (!env.RELAY_TOKEN || env.RELAY_TOKEN.length < 24) {
      return json(500, { error: 'RELAY_TOKEN secret is missing or shorter than 24 characters' });
    }
    const auth = request.headers.get('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!(await tokenMatches(presented, env.RELAY_TOKEN))) return json(401, { error: 'unauthorized' });

    const stub = env.HUB.get(env.HUB.idFromName('default'));
    return stub.fetch(request);
  },
};

// ---- remote MCP connector ---------------------------------------------------

function hubStub(env) {
  return env.HUB.get(env.HUB.idFromName('default'));
}

// Minimal client for calling the Durable Object from inside the Worker.
export function createHubClient(stub) {
  async function call(method, path, body) {
    const response = await stub.fetch(new Request(`https://hub${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  return {
    postEvent: (event) => call('POST', '/v1/events', event),
    createAsk: (ask) => call('POST', '/v1/asks', ask),
    waitAsk: (id, waitMs) => call('GET', `/v1/asks/${encodeURIComponent(id)}?wait=${waitMs}`),
  };
}

async function handleMcp(request, env, url) {
  if (!env.MCP_SECRET || env.MCP_SECRET.length < 24) {
    return json(404, { error: 'not found' }); // connector disabled until MCP_SECRET is set
  }
  const presented = url.pathname.slice('/mcp/'.length).replace(/\/+$/, '');
  if (!(await tokenMatches(presented, env.MCP_SECRET))) return json(404, { error: 'not found' });
  if (request.method === 'GET') return new Response(null, { status: 405, headers: { Allow: 'POST', ...CORS } }); // no SSE stream
  if (request.method === 'DELETE') return new Response(null, { status: 204, headers: CORS }); // stateless: nothing to end
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', ...CORS } });

  let message;
  try {
    message = await readJson(request);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const handler = createMcpHandler({ hub: createHubClient(hubStub(env)), source: 'duet', project: 'Claude' });
  const response = await handler.handle(message);
  if (!response) return new Response(null, { status: 202, headers: CORS });
  return json(200, response);
}

export class HubObject {
  constructor(state) {
    this.state = state;
    this.hub = new Hub();
    this.state.blockConcurrencyWhile(async () => {
      this.hub.restore(await this.state.storage.get('snapshot'));
    });
  }

  async persist() {
    await this.state.storage.put('snapshot', this.hub.snapshot());
  }

  async fetch(request) {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      if (error instanceof SyntaxError) return json(400, { error: 'invalid JSON body' });
      console.error("hub error", error && error.stack || error);
      return json(500, { error: "internal error" });
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['v1', ...]
    const method = request.method;
    if (parts[1] === 'clips') return this.routeClips(parts, method, request);
    const body = method === 'POST' ? await readJson(request) : null;

    if (parts[1] === 'events' && parts.length === 2 && method === 'POST') {
      const event = this.hub.addEvent(body);
      await this.persist();
      return json(201, { event });
    }
    if (parts[1] === 'feed' && parts.length === 2 && method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(200, await this.hub.waitFeed(since, url.searchParams.get('wait')));
    }
    if (parts[1] === 'asks') {
      if (parts.length === 2 && method === 'POST') {
        const ask = this.hub.createAsk(body);
        await this.persist();
        return json(201, { ask });
      }
      const id = parts[2];
      if (parts.length === 3 && method === 'GET') {
        return json(200, { ask: await this.hub.waitAsk(id, url.searchParams.get('wait')) });
      }
      if (parts.length === 4 && parts[3] === 'answer' && method === 'POST') {
        const ask = this.hub.answerAsk(id, body);
        await this.persist();
        return json(200, { ask });
      }
      if (parts.length === 4 && parts[3] === 'attach' && method === 'POST') {
        const ask = this.hub.attachClip(id, body);
        await this.persist();
        return json(200, { ask });
      }
      if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
        const ask = this.hub.cancelAsk(id);
        await this.persist();
        return json(200, { ask });
      }
    }
    return json(404, { error: 'not found' });
  }

  // Short audio clips (TTS replies, recorded voice replies). Stored as
  // individual Durable Object values with an index for expiry.
  async routeClips(parts, method, request) {
    if (parts.length === 2 && method === 'POST') {
      const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
      if (!/^audio\/[a-z0-9.+-]+$/i.test(type)) throw new HttpError(415, 'Content-Type must be audio/*');
      const data = await request.arrayBuffer();
      if (data.byteLength === 0) throw new HttpError(400, 'empty clip');
      if (data.byteLength > MAX_CLIP_BYTES) throw new HttpError(413, 'clip too large');
      const id = crypto.randomUUID();
      const index = await this.pruneClips();
      index[id] = Date.now();
      await this.state.storage.put({ [`clip:${id}`]: { type, data }, clipIndex: index });
      return json(201, { clip: { id, type, size: data.byteLength } });
    }
    if (parts.length === 3 && method === 'GET') {
      const clip = await this.state.storage.get(`clip:${parts[2]}`);
      if (!clip) throw new HttpError(404, 'clip not found');
      return new Response(clip.data, { headers: { 'Content-Type': clip.type, 'Cache-Control': 'no-store', ...CORS } });
    }
    return json(404, { error: 'not found' });
  }

  async pruneClips() {
    const index = (await this.state.storage.get('clipIndex')) || {};
    const expired = Object.keys(index).filter((id) => Date.now() - index[id] > CLIP_TTL_MS);
    if (expired.length) {
      await this.state.storage.delete(expired.map((id) => `clip:${id}`));
      for (const id of expired) delete index[id];
    }
    return index;
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 16_384) throw new HttpError(413, 'body too large');
  return text ? JSON.parse(text) : {};
}
