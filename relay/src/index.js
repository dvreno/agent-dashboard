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
//   GET  /v1/feed?since=seq&wait=ms phone → long-poll for new events + pending asks

import { Hub, HttpError } from './hub.js';

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
      if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
        const ask = this.hub.cancelAsk(id);
        await this.persist();
        return json(200, { ask });
      }
    }
    return json(404, { error: 'not found' });
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 16_384) throw new HttpError(413, 'body too large');
  return text ? JSON.parse(text) : {};
}
