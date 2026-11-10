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
- Optional: a HOGP ring (D06 / D06 Pro, XGIMI remote or KiWear). Bind it in the App under
  **Third-party devices (HOGP)** while wearing the glasses, not in the phone's Bluetooth settings. Only
  one accessory is stored; unpair any other first.

## 0. Build

```sh
cd agent-dashboard
export MEMOMIND_SDK=~/MemoMind/plugin-open-platform PYTHON=~/.cache/GMPluginSDK/venv/bin/python
npm run build:glasses   # dist/agent_hud.gmp + agent_hud.review.json + agent_hud.review-source.enc
npm run package         # dist/agent-dashboard-0.3.0.mmpkg
npm test                # 96 tests, including the native simulator and the inputmap files
```

`build:glasses` prints the Flash size. It's about 16 KB today, so there's plenty of room under the 500 KiB limit.

## 1. Studio simulator

1. Studio → **Import package** → `dist/agent-dashboard-0.3.0.mmpkg`.
2. **Import package** → `dist/agent_hud.gmp`. `manifest.json` sits beside it, so Studio can see the
   `dvreno.agent-hud` protocol. Check that Studio lists it as **recommended** for the phone plugin,
   and that the glasses plugin shows as **Agent Dashboard HUD (dvreno)** (the glasses cache plugins
   by this name, so it must not clash with another plugin's).
3. Start both. On the phone page, enter the relay URL and token and press **Save & connect**. The
   phone log should say `Using the Agent Dashboard glasses plugin` and `… 12 icons sent`.
4. On the glasses display: the header shows `Claude - idle`, and an icon is drawn at the top left.
5. Run something in Claude Code. Lines appear with icons, and the footer says `LIVE`.
6. Click the button (Studio's main button): the view pages back and the footer says `N lines back`.
   Keep clicking: after the last 12 events the footer says `Oldest here - full history on the phone`,
   and the phone page's **History** list has everything. Double-click: you're back to `LIVE`.
7. Use Studio's input panel for the buttons an inputmap produces: up/down and scroll step one line,
   page and left/right step one page, back hides an approval card, home goes live.
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

## 3. Ring: import an inputmap

Ring buttons reach the plugin only through an inputmap (official docs: reference/hogp-inputmap).
Follow [`inputmap/README.md`](../inputmap/README.md):

1. Wear the glasses and bind the ring in the App.
2. Record each button in the App, or start from `inputmap/d06-ring.draft.json` (D06; **unverified**)
   or `inputmap/five-key-remote.json` (remotes with the official sample's usages). Put every rule in
   one file: each import replaces the whole table.
3. **Mapping table (inputmap) → Import mapping table**, wait for success.
4. Write the ring model, its firmware, the App version and the working JSON in the results table.
   If the D06 draft is wrong, commit the corrected file and drop `.draft` from its name.

## 4. On the glasses: what to measure

| # | Check | How | Expected |
| --- | --- | --- | --- |
| 1 | Icons arrive | Start the plugin, watch the header and rows | Icons replace the ASCII `> * + !` markers within a few seconds (12 icons ≈ 2 KB) |
| 2 | First load | Have 100 events in the relay, start the plugin | The last 12 events within ~2 s; the phone page lists all 100. Note the time |
| 3 | Live latency | `date` in Claude Code, compare with the HUD | Under 1 s from hook to HUD |
| 4 | Paging speed | Click repeatedly, scroll a ring wheel | Instant: paging uses no Bluetooth |
| 5 | Text fit | Long lines, CJK, emoji | No clipped glyphs (the firmware font may lack emoji; they show as boxes, which is acceptable) |
| 6 | Grey levels | Tool lines are grey 9, text 12, prompts 15 | Distinguishable on the real optics. If not, raise contrast in `draw_rows()` |
| 7 | Nod/shake | 10 nods, 10 shakes on cards | No missed answers, and no answer from a nod that started before the card appeared |
| 8 | Head paging | Turn head left/right while reading | Pages. If it triggers by accident during normal use, turn it off with `CMD_CONFIG` (`headPaging: false`) |
| 9 | High risk | Nod, then button within 5 s; nod, then wait 6 s | Allowed only in the first case |
| 10 | Ring through the inputmap | Each mapped ring button: press, release, press again | The view moves as the [inputmap table](../inputmap/README.md) says; no button triggers the wrong action. Retest after the ring reconnects and after a glasses reboot |
| 11 | Raw input (optional, undocumented) | `CMD_CONFIG` raw on (`encodeConfig({ raw: true })`) | Phone log says `raw input on` and `EVT_INPUT` codes appear, or it stays off on firmware without Input extension 4. Inputmap buttons keep working either way |
| 12 | Reconnect | Walk away until Bluetooth drops, come back | `Phone disconnected` toast; history kept; only new lines resent (`need`/hello) |
| 13 | Phone locked | Lock the phone for 2 minutes during a session | Unknown. Note whether lines keep arriving (App foreground limits) |
| 14 | Phone call | Receive a call | The HUD hides during the call UI and comes back afterwards |
| 15 | Memory | Leave it running through 200+ events | No crash; the glasses keep the last 12 events (6 KB / 160 lines); the phone keeps 400 |
| 16 | Exit/relaunch | Long press, start again | Clean start: the phone resends the last 12 events |
| 17 | Fallback | Run the phone plugin with the stock GM Web Bridge | Phase 1–3 text screens still work after 2.5 s of detection |
| 18 | Long reply | Ask Claude for a long answer | The glasses show the start and `... (full text on the phone)`; the phone page has all of it |
| 19 | Brightness | Change brightness, start and stop the plugin | Brightness is back to your setting after the plugin stops (the Host restores it) |

## 5. Results

| Date | App | Firmware | Ring (model, firmware, inputmap file) | Checks passed | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Known unknowns

- The D06 ring's real HID usages (the draft inputmap assumes mouse buttons on page 9), and whether
  its wheel can be mapped at all (it may need a `value_match` rule on Generic Desktop usage 56).
- Whether any firmware exposes the SDK's Input extension 4; the official docs don't mention it.
- Whether `image_create` with a 16×16 indexed image renders at the expected size on device.
- Font line height on device (the layout reads it at runtime; 12 rows assumes ~17 px).
- Whether `device.messaging` is granted together with the other permissions in the App's consent screen.
- Whether the App allows the phone plugin to run with `preferredPluginId` pointing at a sideloaded GMP.
