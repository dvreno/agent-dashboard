# hud_input

One input API for MemoMind glasses plugins (`.gmp`, C gnu99, no libc, no allocation).

Wearers give input in three ways, and each arrives through a different part of the SDK:

| Source | SDK path | hud_input source |
| --- | --- | --- |
| The button on the glasses | `GM_PLUGIN_EVENT_BUTTON`, `PRIMARY` single/double | `HI_SRC_BUTTON` |
| Head gestures | `GM_PLUGIN_EVENT_IMU_GESTURE` nod/shake/left/right/raise/lower | `HI_SRC_HEAD` |
| HOGP ring, remote, keyboard (cooked) | `GM_PLUGIN_EVENT_BUTTON` UP/DOWN/PAGE_*/SCROLL_*/BACK/HOME `TRIGGER` | `HI_SRC_NAV` |
| HOGP ring, remote, keyboard (raw) | Input extension 4: keys, mouse buttons, wheel, touch swipes, media keys | `HI_SRC_RING` |

hud_input turns all of them into one stream of normalized inputs (`HI_IN_*`), and your keymap turns
each input into an action number of your own.

```c
static void on_action(void *ctx, uint8_t action, const hi_event_t *ev) { /* ... */ }

hi_state_t in;
hi_init(&in, host, on_action, app);
hi_map(&in, HI_IN_HEAD_NOD, ACT_YES);
hi_map(&in, HI_IN_WHEEL_UP, ACT_LINE_UP);
hi_map(&in, HI_IN_BUTTON_SINGLE, ACT_SELECT);

hi_start(&in);                         // on_start / on_resume: claims raw HOGP input if available
if (hi_on_event(&in, event)) return true;   // in on_event
hi_guard_gestures(&in, now, 800);      // ignore a nod that was already happening when a card appeared
hi_stop(&in);                          // on_suspend / on_stop
```

## What it handles for you

- **Raw HOGP subscription.** It claims KEY | REL | TOUCH from Input extension 4 when the firmware
  has it, and falls back to the Host's cooked navigation buttons when it doesn't (older firmware,
  or `hi_set_raw(&in, HI_RAW_OFF)`). Claimed classes no longer produce cooked events, so the same
  key never counts twice.
- **Wheel notches.** Wheel deltas accumulate and emit one `WHEEL_UP/DOWN` per `wheel_step` units
  (`hi_set_wheel_step` for rings with high-resolution wheels).
- **Repeat.** A held navigation key repeats (`PHASE_REPEAT`); everything else fires once
  (`hi_set_repeatable`).
- **Gesture hygiene.** A guard window after a card appears (`hi_guard_gestures`), and duplicate
  edges of one physical nod within 350 ms are dropped.
- **What it leaves alone.** The long press and `KEY_LONG` belong to the Host (they exit plugins),
  and so do head-raise and head-lower timeouts.

Phones can change the keymap at runtime: inputs and actions are plain bytes (see `CMD_CONFIG` in
the Agent Dashboard protocol).

## Rings people use with MemoMind (from the developer Discord)

- D06 / D06 Pro ring mice: HOGP with 3 configurable buttons, and good with the early-November
  controller-mapping update *(community)*.
- XGIMI replacement remote: works, tested by MemoMind staff.
- KiWear: the official partner ring.
- R08: doesn't advertise HID, and the community firmware patch for it is an **untrusted binary**.
- Proprietary BLE (GATT) controllers don't work: only HID Button Usage Page (HOGP) devices do.

Which raw keys each ring sends is not documented. Log `EVT_INPUT` on the phone during the
hardware tests and adjust the keymap.

Tests: `test/native-hud.test.mjs` covers cooked nav, raw keys with repeat, wheel, touch swipes,
remapping, raw off and suspend/resume.
