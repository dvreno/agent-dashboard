// Minimal client for the agent relay, used by the phone plugin.

export class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normaliseUrl(url) {
  const value = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(value) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(value)) {
    throw new RelayError(0, 'Relay URL must start with https://');
  }
  return value;
}

export function createRelayClient({ url, token, fetchImpl = (...args) => fetch(...args) }) {
  const base = normaliseUrl(url);
  async function request(method, path, body, { signal, timeoutMs = 35_000 } = {}) {
    // Manual timeout + abort linking (AbortSignal.any/timeout are missing in older WebViews).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new RelayError(response.status, data.error || `HTTP ${response.status}`);
    return data;
  }
  return {
    // Authenticated round trip, used by the "Test connection" button.
    check: () => request('GET', '/v1/feed?since=0&wait=0', null, { timeoutMs: 8000 }),
    feed: (since, waitMs, signal) => request('GET', `/v1/feed?since=${since}&wait=${waitMs}`, null, { signal, timeoutMs: waitMs + 10_000 }),
    answer: (id, decision, via) => request('POST', `/v1/asks/${encodeURIComponent(id)}/answer`, { decision, via }, { timeoutMs: 10_000 }),
  };
}
