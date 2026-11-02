// Shared relay client for the Claude Code hook and the MCP server.
// Dependency-free so both can run straight from ~/.claude/memomind/.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The token comes from MEMOMIND_RELAY_TOKEN, or (preferred, keeps it out of
// settings.json) from a private file: MEMOMIND_RELAY_TOKEN_FILE, default
// ~/.claude/memomind/relay-token.
export function readToken(env = process.env) {
  if (env.MEMOMIND_RELAY_TOKEN) return env.MEMOMIND_RELAY_TOKEN.trim();
  const file = env.MEMOMIND_RELAY_TOKEN_FILE || join(homedir(), '.claude', 'memomind', 'relay-token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function relayConfig(env = process.env) {
  return { url: (env.MEMOMIND_RELAY_URL || '').replace(/\/+$/, ''), token: readToken(env) };
}

export function createRelay({ url, token }) {
  async function request(method, pathname, body, timeoutMs) {
    const response = await fetch(`${url}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}`);
    return data;
  }

  return {
    request,
    postEvent: (event) => request('POST', '/v1/events', event, 4000),
    feed: () => request('GET', '/v1/feed?since=0&wait=0', null, 8000),
    cancel: (id) => request('POST', `/v1/asks/${encodeURIComponent(id)}/cancel`, {}, 5000),
    attachClip: (id, clipId) => request('POST', `/v1/asks/${encodeURIComponent(id)}/attach`, { clipId }, 8000),

    async uploadClip(bytes, type) {
      const response = await fetch(`${url}/v1/clips`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
        body: bytes,
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}`);
      return data.clip;
    },

    async downloadClip(id) {
      const response = await fetch(`${url}/v1/clips/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`${response.status} clip download failed`);
      return { bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get('Content-Type') || '' };
    },

    // Create an ask and long-poll until it is answered, expires, or the local
    // deadline passes. Never resolves to "allow" on its own: on timeout the ask
    // is withdrawn and returned with its non-allow state.
    async askAndWait(ask, timeoutS, { log = () => {}, signal, onCreated } = {}) {
      const deadline = Date.now() + timeoutS * 1000;
      const created = (await request('POST', '/v1/asks', { ...ask, timeoutMs: timeoutS * 1000 }, 8000)).ask;
      log(`ask ${created.id} created (${created.risk})`);
      onCreated?.(created);
      let current = created;
      while (current.state === 'pending' && Date.now() < deadline && !signal?.aborted) {
        const wait = Math.min(25_000, Math.max(deadline - Date.now(), 0));
        try {
          ({ ask: current } = await request('GET', `/v1/asks/${created.id}?wait=${wait}`, null, wait + 10_000));
        } catch (error) {
          log(`poll failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (current.state === 'pending') {
        await this.cancel(created.id).catch(() => {});
        current = { ...current, state: signal?.aborted ? 'cancelled' : 'expired' };
      }
      return current;
    },
  };
}
