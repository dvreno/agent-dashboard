# hud_render

Bluetooth-friendly drawing for MemoMind glasses plugins (`.gmp`, C gnu99). It has two halves:

| Half | File | Runs on |
| --- | --- | --- |
| Glasses | `hud_render.h`, `hud_render.c` | the glasses, inside your plugin |
| Phone | [`phone/lib/hud-render-kit.js`](../../../phone/lib/hud-render-kit.js) | the MemoMind App WebView (or Node) |

## Why

Bluetooth is the bottleneck. MemoMind staff measure about 200–500 ms per frame, and users report
about 1 fps for full-screen images. A raw 600×350 GRAY_4 frame is 105 000 bytes. The library
follows the recipe staff recommend in the developer Discord:

1. **Draw text and shapes on the glasses with LVGL.** Send strings, not pixels.
   `hr_text`, `hr_cell_set` (only calls LVGL when the text actually changed), `hr_box`, `hr_hline`.
2. **When you need pixels, send little.** Use the green channel only, at 4 bits per pixel, two
   pixels per byte with even x in the high nibble. Compress with LZ4 and resend only the tiles whose
   hash changed. `TileDiffer` in the JS half does all of this; a blank frame costs about 2 KB.
3. **Send assets after launch.** Plugins must stay well under the 500 KiB Flash limit (oversize
   gives `Import failed: Operation failed`). Icons and logos travel over Bluetooth once and become
   LVGL indexed images (`hr_asset_*`), so LVGL keeps compositing them with the rest of the UI.

## API (glasses)

```c
hr_ctx_t r;
hr_init(&r, host);                       // LVGL + libc (required) + LZ4 (optional)

hr_text_style_t st = { .x = 12, .y = 4, .w = 300, .h = 22, .font = HR_FONT_DEFAULT,
                       .grey = 15, .align = GM_PLUGIN_LVGL_TEXT_ALIGN_LEFT,
                       .mode = GM_PLUGIN_LVGL_LABEL_DOT };
hr_cell_t title;
hr_cell_init(&r, &title, root, &st);
hr_cell_set(&r, &title, "Hello");        // no LVGL call if the text is unchanged

hr_assets_t assets;                      // 16 slots
hr_assets_init(&assets);
hr_handle_asset_begin(&r, &assets, body, len, &slot);   // from your Bluetooth handler
hr_handle_asset_tile(&r, &assets, body, len, &slot);    // HR_COMPLETE when hash matches
const gm_plugin_lvgl_image_dsc_t *icon = hr_asset_image(&assets, slot);

hr_handle_fb_tile(&r, body, len);        // LZ4 tile straight into the framebuffer
```

Message bodies are little-endian and go inside your own protocol (one command byte in front):

| Body | Layout |
| --- | --- |
| `ASSET_BEGIN` | slot u8, flags u8, width u16, height u16, tile_rows u16, hash u32 |
| `ASSET_TILE` | slot u8, codec u8 (0 raw, 1 LZ4), tile u16, raw_len u16, payload |
| `FB_TILE` | codec u8, reserved u8, x u16, y u16, w u16, h u16, raw_len u16, payload |

The hash is 32-bit FNV-1a of the packed pixels, so the phone can ask "which assets do you already
have?" and skip them (`hr_asset_hash`).

## API (phone)

```js
import { rgbaToLevels, packGray4, assetMessages, TileDiffer, lz4CompressBlock } from './lib/hud-render-kit.js';

const levels = rgbaToLevels(ctx.getImageData(0, 0, 600, 350).data, 600, 350); // green channel → 0..15
const differ = new TileDiffer({ tileWidth: 120, tileHeight: 50 });
for (const body of differ.diff(levels)) send(wrap(CMD_FB_TILE, body));        // only changed tiles
```

## Notes

- No libc linkage. Memory functions come from the Host libc extension, decompression from
  extension 2 (LZ4), and buffers from `host->alloc`.
- Don't mix framebuffer tiles with LVGL over the same screen area: a later LVGL redraw overwrites
  them (SDK rule). Use assets for anything that sits inside an LVGL UI.
- Keep large plugin state on the heap, not in one big static struct. GCC addresses fields of a
  big `.bss` struct as `symbol + 0x2000 - n`, and the GlassSDK XIP packer rejects that as
  `relocation address outside image`.
- Tests: `test/render-kit.test.mjs` (JS), and `test/native-hud.test.mjs` decodes the JS encoder's
  LZ4 with the reference `liblz4` inside the native test Host.
