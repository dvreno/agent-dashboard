# Ring and remote inputmaps

Ring buttons reach the glasses plugin only through an **inputmap** you import in the MemoMind App
(official docs: *reference/hogp-inputmap*, *build/hogp-accessories*). The glasses decode the ring's
HID reports, apply the map, and hand the plugin ordinary `GM_PLUGIN_EVENT_BUTTON` events. The plugin
never sees raw HID data or the JSON.

## What Agent Dashboard does with each output

| inputmap key (`key`) | GMP button | Agent Dashboard |
| --- | --- | --- |
| SCROLL_UP 56 / SCROLL_DOWN 57 | SCROLL_UP / SCROLL_DOWN | one line back / forward (repeats while held) |
| UP 0 / DOWN 1 | UP / DOWN | one line back / forward |
| PAGE_UP 54 / PAGE_DOWN 55, LEFT 2 / RIGHT 3 | PAGE_UP / PAGE_DOWN, LEFT / RIGHT | one page back / forward |
| SELECT 4 | PRIMARY single | same as the glasses button: read back, confirm a high-risk approval, return to the card |
| DOUBLE 58 | PRIMARY double | back to live / next approval |
| BACK 5 / HOME 6 | BACK / HOME | hide the card to read / back to live |

MENU, media and volume keys never reach a plugin, so don't map ring buttons to them for this plugin.
A long press on SELECT stays with the Host (it exits the plugin).

## Files

| File | For | Status |
| --- | --- | --- |
| [`five-key-remote.json`](five-key-remote.json) | Remotes that send the official sample's Consumer-page usages (page 12, usages 66/67/68/69/65) | The official template's inputs with outputs picked for this plugin: up/down scroll, left/right page, centre confirms |
| [`d06-ring.draft.json`](d06-ring.draft.json) | D06 / D06 Pro ring mice | **Unverified draft.** Assumes the three buttons report as mouse buttons (Button page 9, usages 1/2/3). Nobody has captured a D06 report map yet |

## Make or check a map for your ring

1. Wear the glasses, open the App, and bind the ring under **Third-party devices (HOGP)**. Only one
   accessory is stored at a time; unpair the old one first.
2. Use the App's **recording** for each physical button to see its real page and usage, or read the
   ring's Report Map. Don't copy another model's values.
3. Edit a JSON file here so each `page`/`usage` matches what you recorded. Use decimal numbers; JSON
   allows no comments and no `0x`. If one usage sends different values for different buttons, use a
   `value_match` rule instead.
4. **Mapping table (inputmap) → Import mapping table.** Each import replaces the whole table, so put
   every rule in one file.
5. Test every button in Agent Dashboard: press, release, and press again. Also test after the ring
   reconnects and after the glasses reboot.
6. Write the ring model, firmware, App version and the working JSON in `glasses/HARDWARE_TESTING.md`.

Limits (current App and firmware): the file is at most 8192 bytes; at most 16 `usage_key` rules; at most
4 `value_match` rules with at most 6 values each; only the output keys listed in the docs
(0–13, 54–58, 65535). `npm test` checks the files here against these limits.
