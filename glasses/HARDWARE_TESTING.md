# Phase 4: testing on real glasses

Nothing in phase 4 has run on real glasses or in Desktop Studio yet. The native tests run the real C
code on a fake Host, which checks the logic but not timing, fonts, optics, Bluetooth or real HOGP
devices. Do these in order and write the results in the table at the end.

## You need

- MemoMind One glasses with firmware that supports the current SDK ABI, connected through the
  MemoMind App (not just system Bluetooth).
- The App's **Developer Workspace** (allowlisted account, Android App ≥ 1.3.81).
- A Mac with **MemoMind Plugin Studio**, on the same Wi-Fi as the phone, with the firewall open for
  Studio's plugin service.
- The relay running (`wrangler dev` for local testing, or your deployed Worker) and the Claude Code
  hook installed (see the main README).
- Optional: a HOGP ring (D06 / D06 Pro, XGIMI remote or KiWear). Pair it to the **glasses**, not the phone.

## 0. Build

```sh
cd agent-dashboard
export MEMOMIND_SDK=~/MemoMind/plugin-open-platform PYTHON=~/.cache/GMPluginSDK/venv/bin/python
npm run build:glasses   # dist/agent_hud.gmp + agent_hud.review.json + agent_hud.review-source.enc
npm run package         # dist/agent-dashboard-0.3.0.mmpkg
npm test                # 89 tests, including the native simulator
```

`build:glasses` prints the Flash size. It's about 16 KB today, so there's plenty of room under the 500 KiB limit.

## 1. Studio simulator

1. Studio → **Import package** → `dist/agent-dashboard-0.3.0.mmpkg`.
2. **Import package** → `dist/agent_hud.gmp`. `manifest.json` sits beside it, so Studio can see the
   `dvreno.agent-hud` protocol. Check that Studio lists it as **recommended** for the phone plugin.
3. Start both. On the phone page, enter the relay URL and token and press **Save & connect**. The
   phone log should say `Using the Agent Dashboard glasses plugin` and `… 12 icons sent`.
4. On the glasses display: the header shows `Claude - idle`, and an icon is drawn at the top left.
5. Run something in Claude Code. Lines appear with icons, and the footer says `LIVE`.
6. Click the button (Studio's main button): the view pages back and the footer says `N lines back`.
   Double-click: you're back to `LIVE`.
7. Use Studio's accessory/input panel: wheel, arrow keys, page keys and touch swipes all scroll.
8. Trigger a permission prompt in Claude Code. A card appears, and the waiting bar reads
   `Approve? …`. Use head-motion **nod** in Studio and check that Claude Code continues. Repeat with
   a high-risk command (`rm -rf /tmp/x`): nod, then button within 5 s.
9. Press **long** on the button: the plugin exits through the Host. Check Studio's logs for errors.

Studio isn't rate-limited, so don't judge speed here.

## 2. On the glasses: delivery

1. In Studio, select both plugins and wait for the QR code. If you see *Missing build review
   snapshot*, rebuild with `npm run build:glasses` and don't mix sidecars from different builds.
2. App → Settings → Memo Lab → Developer Workspace → **Scan to open app**, then authorise.
3. If you get `Import failed: Operation failed`, write down the `.gmp` size and the App and
   firmware versions. At 16 KB, size shouldn't be the cause.

## 3. On the glasses: what to measure

| # | Check | How | Expected |
| --- | --- | --- | --- |
| 1 | Icons arrive | Start the plugin, watch the header and rows | Icons replace the ASCII `> * + !` markers within a few seconds (12 icons ≈ 2 KB) |
| 2 | First history load | Have 100 events in the relay, start the plugin | All lines within ~3 s. Note the time |
| 3 | Live latency | `date` in Claude Code, compare with the HUD | Under 1 s from hook to HUD |
| 4 | Paging speed | Click repeatedly, scroll a ring wheel | Instant: paging uses no Bluetooth |
| 5 | Text fit | Long lines, CJK, emoji | No clipped glyphs (the firmware font may lack emoji; they show as boxes, which is acceptable) |
| 6 | Grey levels | Tool lines are grey 9, text 12, prompts 15 | Distinguishable on the real optics. If not, raise contrast in `draw_rows()` |
| 7 | Nod/shake | 10 nods, 10 shakes on cards | No missed answers, and no answer from a nod that started before the card appeared |
| 8 | Head paging | Turn head left/right while reading | Pages. If it triggers by accident during normal use, turn it off with `CMD_CONFIG` (`headPaging: false`) |
| 9 | High risk | Nod, then button within 5 s; nod, then wait 6 s | Allowed only in the first case |
| 10 | Ring raw keys | Each ring button, wheel and swipe | Phone log shows `EVT_INPUT` codes, and the view moves. Record the codes per ring |
| 11 | Ring without raw | `CMD_CONFIG` raw off | Cooked UP/DOWN/PAGE keys still scroll |
| 12 | Reconnect | Walk away until Bluetooth drops, come back | `Phone disconnected` toast; history kept; only new lines resent (`need`/hello) |
| 13 | Phone locked | Lock the phone for 2 minutes during a session | Unknown. Note whether lines keep arriving (App foreground limits) |
| 14 | Phone call | Receive a call | The HUD hides during the call UI and comes back afterwards |
| 15 | Memory | Leave it running through 1000+ lines | No crash; old lines drop off (pool 24 KB / 1024 lines) |
| 16 | Exit/relaunch | Long press, start again | Clean start: history is resent from the phone |
| 17 | Fallback | Run the phone plugin with the stock GM Web Bridge | Phase 1–3 text screens still work after 2.5 s of detection |

## 4. Results

| Date | App | Firmware | Ring | Checks passed | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Known unknowns

- Raw HOGP key codes per ring model (D06 sends mouse buttons and wheel? KiWear gestures?).
- Whether `image_create` with a 16×16 indexed image renders at the expected size on device.
- Font line height on device (the layout reads it at runtime; 12 rows assumes ~17 px).
- Whether `device.messaging` is granted together with the other permissions in the App's consent screen.
- Whether the App allows the phone plugin to run with `preferredPluginId` pointing at a sideloaded GMP.
