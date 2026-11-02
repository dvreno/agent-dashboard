# Agent Dashboard

See what Claude Code is doing on your MemoMind glasses, and answer its permission
prompts with your head: **nod = allow, shake = deny.**

```
Claude Code (MacBook)                Cloudflare Worker              MemoMind App (phone)         Glasses
  hooks ──── events / asks ────────▶  relay (Durable Object)  ◀──── long-poll ──── Web plugin ──▶ HUD text
  hook  ◀─── allow / deny ─────────   pending asks            ◀──── answer ─────── nod / shake / button
```

| Part | Path | Runs on |
| --- | --- | --- |
| Relay | [`relay/`](relay/) | Cloudflare Workers (free plan), one Durable Object |
| Hook | [`hook/memomind-hook.mjs`](hook/memomind-hook.mjs) | Your computer, called by Claude Code |
| Phone plugin | [`phone/`](phone/) | MemoMind App WebView. Draws through the stock `web_bridge` glasses plugin, so there's no C code |

Status: phases 1 (status feed) and 2 (approvals). Tested with unit tests, end-to-end tests
against a local Worker, and the PhoneSDK Browser Studio. **Not yet tested on real glasses.**

## What you see

| Idle | Approval | High-risk approval |
| --- | --- | --- |
| `AGENTS 14:05` + each session's state and last action, plus the last finished task | Project · session, the action (`Run command` / `npm run build`), `NOD = allow  SHAKE = deny  87s` | `!! HIGH RISK`, and after a nod: `PRESS BUTTON to confirm (5s)` |

Controls on the glasses:

| Input | Effect |
| --- | --- |
| Nod | Allow (normal risk) or arm (high risk) |
| Shake | Deny |
| Single click | Confirm an armed high-risk approval. Never approves on its own |
| Double click | Next waiting approval, when there are several |

The phone page shows the same approvals with Allow/Deny buttons, so you can use the phone as a fallback.

## Safety rules

- **Nothing is approved by default.** No answer within `MEMOMIND_ASK_TIMEOUT` (90 s) means **deny**.
  Set `MEMOMIND_TIMEOUT_ACTION=prompt` to fall back to the normal terminal prompt instead.
- If the relay is down or misconfigured, the hook prints nothing, so Claude Code shows its normal prompt.
- **High risk** needs a nod and then a button press within 5 s. This covers `rm -rf`, force or
  protected-branch pushes, `git reset --hard`, `sudo`, `curl | sh`, deploy/publish, `terraform apply`,
  `kubectl delete`, `DROP TABLE`, and writes outside the project or to `.env`/keys.
  The list is in [`hook/lib.mjs`](hook/lib.mjs).
- Gestures are ignored for 0.8 s after a card appears, so a nod that was already happening can't count.
- Secrets (API keys, tokens, passwords, private keys) are redacted before anything leaves your machine.
- One shared token (≥24 chars) protects the relay. Compared in constant time; CORS open, auth by header.
- Claude Code's own deny rules still apply: an allow from the glasses can't override them.

## Setup

You need Node 18+, a free Cloudflare account, and the
[plugin-open-platform](https://github.com/memomind-open/plugin-open-platform) toolkit for Studio.

### 1. Deploy the relay

```sh
cd plugins/agent-dashboard/relay
npm install
npx wrangler login
openssl rand -hex 24               # copy this token
npx wrangler secret put RELAY_TOKEN   # paste it
npx wrangler deploy                # note the https://memomind-agent-relay.<you>.workers.dev URL
curl https://memomind-agent-relay.<you>.workers.dev/health   # {"ok":true}
```

### 2. Install the Claude Code hook (MacBook)

```sh
mkdir -p ~/.claude/memomind
cp plugins/agent-dashboard/hook/*.mjs ~/.claude/memomind/
```

Merge [`hook/settings.example.json`](hook/settings.example.json) into `~/.claude/settings.json`
(user-level, so it covers every project). Fill in your relay URL and token. Status hooks run with
`"async": true`, so they never slow Claude down. The `PermissionRequest` hook waits for your answer.

Turn it off temporarily with `MEMOMIND_DISABLED=1`.
Use `MEMOMIND_DEBUG=1` to print hook diagnostics to stderr.

### 3. Run the phone plugin

**Simulator (no glasses needed):** in Desktop Studio, import the toolkit workspace and use
*Import package* to load `dist/agent-dashboard-<version>.mmpkg` (build it with `npm run package`, see
below). Pick **GM Web Bridge** as the glasses plugin. Open the phone page, enter the relay URL and
token, then press **Save & connect**. Studio has no nod/shake controls, so answer with the phone
buttons there.

**On glasses (needs Developer Workspace):** scan Studio's QR code from App › Settings › Memo Lab ›
Developer Workspace. The plugin is saved in the App, so later you just tap *Start*.

### 4. Try it

Start Claude Code anywhere and ask it to do something that needs permission (for example run a
command that isn't allowlisted). The card appears on the glasses within about a second.

## Development

```sh
cd plugins/agent-dashboard
npm test                                       # 31 unit tests (relay, hook, HUD logic)

# local relay
cd relay && echo 'RELAY_TOKEN=local-dev-token-0123456789abcdef' > .dev.vars && npx wrangler dev

# end-to-end: real hook script + phone relay client against the local relay
RELAY_TOKEN=local-dev-token-0123456789abcdef npm run test:e2e

# Browser Studio smoke test (Playwright): nod / nod+button / shake through the simulator
node <SDK>/PhoneSDK/tools/run-browser-studio.mjs --plugin "$PWD/phone" --port 4173
RELAY_TOKEN=local-dev-token-0123456789abcdef OUT_DIR=/tmp npm run test:studio

# package the phone plugin with the official packager
MEMOMIND_SDK=/path/to/plugin-open-platform npm run package   # → dist/agent-dashboard-0.1.0.mmpkg
```

`phone/index.html` allows `connect-src https://*.workers.dev` (plus localhost:8787 for development).
If you put the relay on a custom domain, add it there.

### Relay API

All routes except `/health` need `Authorization: Bearer <RELAY_TOKEN>`.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | anyone | liveness |
| POST | `/v1/events` | hook | `{kind, session, project, title, text}` with kind = session, prompt, tool, notify, done, error, status |
| POST | `/v1/asks` | hook | `{title, detail, risk, session, project, timeoutMs}` → `{ask}` |
| GET | `/v1/asks/:id?wait=ms` | hook | long-poll (≤25 s) for `state`: pending, allow, deny, expired, cancelled |
| POST | `/v1/asks/:id/cancel` | hook | withdraw an ask (hook timed out) |
| POST | `/v1/asks/:id/answer` | phone | `{decision: allow\|deny, via}`. 409 if already resolved |
| GET | `/v1/feed?since=seq&wait=ms` | phone | long-poll for new events and the current pending asks |

## Known limits / to verify on hardware

1. **Foreground only.** The MemoMind App must be open with the plugin running. We don't yet know whether
   it keeps polling with the phone locked. This is the first thing to test on device.
2. Gesture thresholds and firmware text wrapping differ from the simulator. Tune `SETTLE_MS` and the
   layout in [`phone/screen.js`](phone/screen.js).
3. Long-press is avoided on purpose, because it exits plugins.
4. One relay = one user. The relay isn't designed for sharing between people.

## Roadmap

- Phase 3: MCP server so any agent can call `glasses_notify` / `glasses_ask`.
- Phase 4: custom `.gmp` with icons, history scrolling and ring support.
- Phase 5: hold-to-talk voice replies (glasses mic → speech-to-text → Claude).
