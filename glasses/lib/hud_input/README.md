# hud_input

One input API for MemoMind glasses plugins (`.gmp`, C gnu99, no libc, no allocation).

Wearers give input in three ways, and each arrives through a different part of the SDK:

| Source | SDK path | hud_input source |
| --- | --- | --- |
| The button on the glasses | `GM_PLUGIN_EVENT_BUTTON`, `PRIMARY` single/double | `HI_SRC_BUTTON` |
| Head gestures | `GM_PLUGIN_EVENT_IMU_GESTURE` nod/shake/left/right/raise/lower | `HI_SRC_HEAD` |
| HOGP ring or remote, after the App's inputmap | `GM_PLUGIN_EVENT_BUTTON` UP/DOWN/LEFT/RIGHT/PAGE_*/SCROLL_*/BACK/HOME `TRIGGER`; SELECT arrives as `PRIMARY` | `HI_SRC_NAV` |
| Raw HOGP (opt-in, undocumented) | Input extension 4: keys, mouse buttons, wheel, touch swipes, media keys | `HI_SRC_RING` |

The official path for rings is the **inputmap** the user imports in the MemoMind App (docs:
reference/hogp-inputmap). The glasses map the ring's HID usages to a fixed set of outputs and the
Host delivers them as button events; plugins never see HID data. MENU, media and volume outputs never
reach a plugin, and only one accessory is bound at a time. Input extension 4 exists in the SDK headers
but isn't in the docs, so hud_input leaves it off unless you call `hi_set_raw(&in, HI_RAW_AUTO)`.

hud_input turns all of them into one stream of normalized inputs (`HI_IN_*`), and your keymap turns
each input into an action number of your own.

```c
static void on_action(void *ctx, uint8_t action, const hi_event_t *ev) { /* ... */ }

hi_state_t in;
hi_init(&in, host, on_action, app);
hi_map(&in, HI_IN_HEAD_NOD, ACT_YES);
hi_map(&in, HI_IN_WHEEL_UP, ACT_LINE_UP);
hi_map(&in, HI_IN_BUTTON_SINGLE, ACT_SELECT);

hi_start(&in);                         // on_start / on_resume (claims raw input only if you opted in)
if (hi_on_event(&in, event)) return true;   // in on_event
hi_guard_gestures(&in, now, 800);      // ignore a nod that was already happening when a card appeared
hi_stop(&in);                          // on_suspend / on_stop
```

## What it handles for you

- **Inputmap buttons by default.** Ring buttons come in as the Host's button events. With
  `hi_set_raw(&in, HI_RAW_AUTO)` it also claims KEY | REL | TOUCH from Input extension 4 when the
  firmware has it; claimed classes no longer produce cooked events, so a key never counts twice.
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

What each ring's buttons send is not documented. Record them in the App and write an inputmap; see
[`inputmap/README.md`](../../../inputmap/README.md) for the files and steps.

Tests: `test/native-hud.test.mjs` covers cooked nav, raw keys with repeat, wheel, touch swipes,
remapping, raw off and suspend/resume.
