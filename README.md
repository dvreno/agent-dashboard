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
| Relay | [`relay/`](relay/) | Cloudflare Workers (free plan), one Durable Object. Also serves the remote MCP connector for Claude Duet |
| Hook | [`hook/memomind-hook.mjs`](hook/memomind-hook.mjs) | Your computer, called by Claude Code |
| Phone plugin | [`phone/`](phone/) | MemoMind App WebView. Talks to the glasses plugin below, or falls back to the stock `web_bridge` GMP |
| Glasses plugin | [`glasses/agent_hud/`](glasses/agent_hud/) | The glasses (`.gmp`, C). Paged reader for the last 12 events, icons, ring support (phase 4) |

Status: phases 1–5 are built. Phase 4 (the glasses plugin) is tested with a native simulator that
runs the real C code on a fake Host, and its `.gmp` builds with the official `build.py`.
**Not yet run in Desktop Studio or on real glasses**: see [glasses/HARDWARE_TESTING.md](glasses/HARDWARE_TESTING.md).

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
Clone both side by side (the scripts look for `../plugin-open-platform` unless you set `MEMOMIND_SDK`):

```sh
git clone https://github.com/memomind-open/plugin-open-platform
git clone https://github.com/dvreno/agent-dashboard
```

### 1. Deploy the relay

```sh
cd agent-dashboard/relay
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
cp agent-dashboard/hook/*.mjs ~/.claude/memomind/
```

Merge [`hook/settings.example.json`](hook/settings.example.json) into `~/.claude/settings.json`
(user-level, so it covers every project). Fill in your relay URL and token. Status hooks run with
`"async": true`, so they never slow Claude down. The `PermissionRequest` hook waits for your answer.

Turn it off temporarily with `MEMOMIND_DISABLED=1`.
Use `MEMOMIND_DEBUG=1` to print hook diagnostics to stderr.

### 3. Run the phone plugin

Build the package first. This copies MemoMind's Web SDK from your toolkit checkout into
`phone/vendor/`. The SDK isn't committed here because MemoMind keeps the rights to it:

```sh
cd agent-dashboard
MEMOMIND_SDK=~/path/to/plugin-open-platform npm run package   # → dist/agent-dashboard-0.1.0.mmpkg
```

**Simulator (no glasses needed):** in Desktop Studio, import the toolkit workspace and use
*Import package* to load `dist/agent-dashboard-<version>.mmpkg`. Pick **GM Web Bridge** as the glasses plugin. Open the phone page, enter the relay URL and
token, then press **Save & connect**. Studio has no nod/shake controls, so answer with the phone
buttons there.

**On glasses (needs Developer Workspace):** scan Studio's QR code from App › Settings › Memo Lab ›
Developer Workspace. The plugin is saved in the App, so later you just tap *Start*.

### 4. Try it

Start Claude Code anywhere and ask it to do something that needs permission (for example run a
command that isn't allowlisted). The card appears on the glasses within about a second.

## Development

```sh
cd agent-dashboard
MEMOMIND_SDK=/path/to/plugin-open-platform npm run setup   # vendor the Web SDK into phone/vendor/ (gitignored)
npm test                                       # 96 tests: relay, hook, HUD logic, render kit, inputmaps, and the
                                               # glasses plugin in a native simulator (needs cc + GlassSDK headers)

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

## Paged reader on the glasses (phase 4)

Terminal Mode's main complaints in the MemoMind Discord are that text moves too fast and that you
can't scroll back. Phase 4 adds a native glasses plugin with a short reading window: the glasses keep
the **last 12 events** and page through them locally, so paging costs no Bluetooth. The **full
history stays on the phone page**, following MemoMind's design guidance ("Keep long forms, history,
and detailed instructions on the phone", design/index). Text longer than about 1000 bytes is cut on
the glasses with "... (full text on the phone)", and the oldest page of the window says
"Oldest here - full history on the phone".

```
 Claude · web - working                        14:05
┌ Approve? Run command: npm run build ──────────────┐   ← what the agent is waiting for
 > Fix the flaky login test and run the suite
 * Read: src/login.test.js
 * Bash: npm test -- login
 + Finished
   The test waited for a fixed 200 ms. I replaced it  ← long replies wrap and keep paragraphs
   with waitFor on the redirect …
 ─────────────────────────────────────────────────────
 37 lines back   5 new                double-click: live
```

| Input | Reading | On an approval card |
| --- | --- | --- |
| Click | Page back | Confirm an armed high-risk approval / talk on a voice card |
| Double click | Back to live | Next card |
| Nod / shake | – | Allow (or arm, if high risk) / deny |
| Head left / right | Page back / forward (can be turned off) | Scroll the card's detail |
| Ring scroll or up/down | One line | Scroll the card's detail |
| Ring page or left/right | One page | Scroll the card's detail |
| Ring select | Same as a click | Same as a click |
| Ring back | Back to live | Hide the card to read what led up to it (click returns) |

Ring buttons reach the plugin only through an **inputmap** imported in the MemoMind App
(Third-party devices (HOGP) → Mapping table). The glasses turn the ring's HID reports into ordinary
button events; MENU, media and volume keys never reach a plugin, and only one ring can be bound at a
time. [`inputmap/`](inputmap/) has a map for remotes that send the official five-key sample's usages,
an **unverified draft for the D06 ring**, and the steps to record your own ring's buttons.

The phone plugin detects the glasses plugin automatically (HELLO on channel `0x4145`). If none
answers within 2.5 s, it falls back to the phase 1–3 text screens through the stock web bridge.

Two parts are written as standalone libraries so they can be published separately:

- [`glasses/lib/hud_render/`](glasses/lib/hud_render/) + [`phone/lib/hud-render-kit.js`](phone/lib/hud-render-kit.js):
  LVGL text/shape helpers that skip unchanged text; green-channel GRAY_4 (4 bits, 2 px/byte); LZ4;
  only changed tiles; assets (the icons) sent over Bluetooth after launch instead of linked into Flash.
- [`glasses/lib/hud_input/`](glasses/lib/hud_input/): one API for the glasses button, head gestures,
  and HOGP rings as the Host delivers them after the App's inputmap, with a keymap the phone can
  change at runtime. It can also claim the SDK's Input extension 4 for raw keys, wheel and swipes,
  but that is off by default: the official docs only describe the inputmap path.

The protocol is in [`glasses/agent_hud/agent_proto.h`](glasses/agent_hud/agent_proto.h) (C) and
[`phone/native-link.js`](phone/native-link.js) (JS).

Glasses limits it is checked against: Flash 500 KiB (the `.gmp` is about 16 KB), static RAM under
100 KiB (8 B; the 6 KB window and other state are allocated at start), and at most 1024 B of stack per
function (the build fails otherwise). The glasses cache plugins by `manifest.name`, not `id`, and hold
at most 28 records, so the `.gmp` is named **"Agent Dashboard HUD (dvreno)"** to avoid clashing with
another plugin. The Host restores display brightness when the plugin stops; the plugin doesn't change
brightness.

Claude's final message is now kept up to 4000 characters, with line breaks (the hook used to cut it
at 200). The phone page shows all of it; the glasses show the first 1000 bytes.

### Build and run

```sh
cd agent-dashboard
export MEMOMIND_SDK=~/MemoMind/plugin-open-platform
python3 -m pip install PyNaCl                # build.py needs it for the review sidecars
npm run build:glasses                       # → dist/agent_hud.gmp + .review.json + .review-source.enc
npm run package                             # → dist/agent-dashboard-0.3.0.mmpkg
```

In Desktop Studio, use **Import package** for both files (keep `dist/manifest.json` beside the
`.gmp`), start them, and enter the relay URL and token on the phone page. To install on the glasses,
scan Studio's QR code from App › Settings › Memo Lab › Developer Workspace.
[glasses/HARDWARE_TESTING.md](glasses/HARDWARE_TESTING.md) has the full checklist.

## Voice conversations (phase 5)

Talk to your Claude Code session through the glasses. Speech-to-text and text-to-speech
run locally on your Mac with [audio.cpp](https://github.com/0xShug0/audio.cpp) on Metal.

```
You speak ─▶ glasses mic ─▶ phone (Ogg Opus, ≤15 s) ─▶ relay ─▶ Mac: ffmpeg → Qwen3-ASR 1.7B ─▶ text
Claude replies ─▶ Mac: Kokoro TTS → MP3 ─▶ relay ─▶ phone plays it + HUD captions (paged)
```

- **Voice mode (Stop hook).** With voice mode on, every time Claude finishes a turn its reply is
  shown on the HUD as captions and spoken by Kokoro. **Click** the glasses button to talk, **click
  again** to send (or it sends at 15 s), and **shake** to end the conversation. Your words are
  transcribed on the Mac and handed back to the *same* session as the next instruction. If you
  say nothing within 180 s the session stops normally. Turn head left/right to page long captions.
- **`glasses_converse` MCP tool.** Claude can start a spoken exchange mid-task and get your answer
  back as text.
- The phone page also has a text box, so you can type replies (useful in Studio, which can't
  simulate the glasses mic).

Measured on an M1 Max (warm): Kokoro ≈ 0.4 s for a 5 s sentence; Qwen3-ASR 1.7B ≈ 0.5 s per reply.
The first request after the server starts loads the model (5–15 s).

### Setup (macOS)

```sh
brew tap 0xShug0/audio-cpp && brew trust 0xShug0/audio-cpp && brew install audio-cpp espeak-ng ffmpeg
mkdir -p ~/MemoMind/audio-models && cd ~/MemoMind/audio-models
audiocpp_model_manager install kokoro_82m_bf16 --models-dir .
audiocpp_model_manager install qwen3_asr_1_7b_q8_0 --models-dir .
```

`~/.claude/memomind/audiocpp-server.json`:

```json
{
  "host": "127.0.0.1", "port": 8089, "backend": "metal", "lazy_load": true,
  "models": [
    { "id": "kokoro", "family": "kokoro_tts", "task": "tts", "mode": "offline",
      "path": "/Users/YOU/MemoMind/audio-models/Kokoro-82M-GGUF/kokoro-82m-bf16.gguf",
      "default_voice_preset": { "voice_id": "af_heart" } },
    { "id": "qwen3-asr", "family": "qwen3_asr", "task": "asr", "mode": "offline",
      "path": "/Users/YOU/MemoMind/audio-models/Qwen3-ASR-1.7B-GGUF" }
  ]
}
```

```sh
audiocpp_server --config ~/.claude/memomind/audiocpp-server.json --log-file ~/.claude/memomind/audiocpp-server.log &
cp hook/*.mjs ~/.claude/memomind/
node ~/.claude/memomind/voicectl.mjs on      # or off / status
```

Register the voice Stop hook (synchronous; it exits in ~0.1 s when voice mode is off):

```json
"Stop": [{ "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/memomind/memomind-voice-hook.mjs\"", "timeout": 600 }] }]
```

Options: `MEMOMIND_TTS=off` (captions only, replies still transcribed), `MEMOMIND_TTS_VOICE`
(any Kokoro voice id), `MEMOMIND_VOICE_TIMEOUT` (seconds, default 180),
`MEMOMIND_AUDIOCPP_URL` (default `http://127.0.0.1:8089`).

Tests: `node test/voice-e2e.mjs` (needs `RELAY_URL`, `RELAY_TOKEN`, a running audio.cpp server,
and macOS `say`, which plays the user's voice).

**Unverified until real glasses:** whether the phone routes Claude's audio to the glasses speaker
(the SDK has no speaker-routing API; captions always work), mic quality outdoors, and whether
recording works with the phone locked.

## Claude Duet and the Claude apps (remote connector)

[Claude Duet](https://techcrunch.com/2026/10/22/claude-duet-app-is-anthropics-bet-on-agents/) is
Anthropic's proactive agent app. It has no public API, but it uses the same connectors as your Claude
account. The relay therefore also works as a **remote MCP server**: add it to Claude as a custom
connector, and Duet (or Claude on the web and mobile) can put its check-ins on your HUD and ask you
yes/no questions that you answer with a nod or a shake.

| Tool | What it does |
| --- | --- |
| `glasses_notify` | Shows a short message on the HUD (title, optional detail, info/done/error) |
| `glasses_ask` | Shows a yes/no question card. Waits up to about 40 s, then returns `yes`, `no`, `no answer`, or `pending` with an `ask_id` |
| `glasses_get_answer` | Keeps waiting on a pending question. Questions stay on the glasses for 5 minutes by default (10 max) |

Cards from Duet are labelled `Claude · duet`. Silence never counts as yes. A glasses answer is an
extra signal for the agent: **it doesn't replace Duet's own confirmation before it sends, pays,
signs or deletes**, which still happens in the Duet app.

### Setup

1. Give the connector its own secret and redeploy the relay:
   ```sh
   cd agent-dashboard/relay
   openssl rand -hex 24                 # copy this; it becomes part of the connector URL
   npx wrangler secret put MCP_SECRET   # paste it
   npx wrangler deploy
   ```
   The connector stays switched off (404) until `MCP_SECRET` is set.
2. In Claude (claude.ai → **Settings → Connectors → Add custom connector**), name it *MemoMind glasses*
   and use the URL `https://memomind-agent-relay.<you>.workers.dev/mcp/<MCP_SECRET>`. Leave OAuth empty.
3. Open Duet and check that *MemoMind glasses* appears among its connected apps. Then tell it how you
   want it used, for example:
   > When something needs my attention, also send a one-line summary to my glasses with glasses_notify.
   > For quick yes/no decisions, ask me on my glasses first.
4. Keep the Agent Dashboard plugin running on your phone so the cards reach the glasses.

**The URL is the password.** Anyone who has it can show messages on your glasses and ask you
questions, but can't read your feed or answer anything. To revoke it, run `wrangler secret put
MCP_SECRET` again with a new value and update the connector.

Test locally:
```sh
# relay/.dev.vars needs RELAY_TOKEN=… and MCP_SECRET=… (24+ characters each)
RELAY_TOKEN=… MCP_SECRET=… node test/duet-connector-e2e.mjs
```

## Known limits / to verify on hardware

1. **Foreground only.** The MemoMind App must be open with the plugin running. We don't yet know whether
   it keeps polling with the phone locked. This is the first thing to test on device.
2. Gesture thresholds and firmware text wrapping differ from the simulator. Tune `SETTLE_MS` and the
   layout in [`phone/screen.js`](phone/screen.js) (web bridge) or
   [`glasses/agent_hud/agent_hud.c`](glasses/agent_hud/agent_hud.c) (native).
3. Long-press is avoided on purpose, because it exits plugins.
4. One relay = one user. The relay isn't designed for sharing between people.
5. If this is ever submitted for MemoMind review/distribution, their terms (§8.5) require disclosing any
   AI providers used. This plugin calls no AI itself; it only relays Claude Code's own prompts.

## Roadmap

- ~~Phase 3: MCP server~~ done: `glasses_notify`, `glasses_ask`, `glasses_converse` (see `hook/memomind-mcp.mjs`).
- ~~Phase 4: custom `.gmp`~~ built: paged reader for the last 12 events (full history on the phone), icons, ring support through inputmaps (see above). Needs a Studio and hardware pass.
- ~~Phase 5: voice replies~~ done (see Voice conversations above).

## License

MIT, see [LICENSE](LICENSE). MemoMind's SDKs are not included and stay under MemoMind's own terms:
the build scripts copy them from your local plugin-open-platform checkout.
