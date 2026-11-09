/*
 * hud_render: Bluetooth-friendly drawing for MemoMind glasses plugins.
 *
 * Bluetooth, not the glasses CPU, is the bottleneck (about 200-500 ms per
 * frame; a raw 600x350 GRAY_4 frame is 105 000 bytes). This library follows
 * the recipe MemoMind staff recommend:
 *
 *   1. Draw text and shapes on the glasses with LVGL. Send strings, not pixels.
 *      hr_text(), hr_cell_set() (skips unchanged text), hr_box(), hr_hline().
 *   2. When pixels are needed, send GRAY_4 (the green channel only, 4 bits per
 *      pixel, two pixels per byte, even x in the high nibble), LZ4-compressed,
 *      and only the tiles that changed. The phone half of the kit
 *      (phone/lib/hud-render-kit.js) does the green-channel conversion,
 *      tiling, hashing and LZ4 encoding.
 *   3. Send assets (icons, logos) over Bluetooth after launch instead of
 *      linking them into the plugin, which must stay well under 500 KiB of
 *      Flash. Received assets become LVGL indexed images (hr_asset_*), so
 *      LVGL keeps compositing them with the rest of the UI.
 *
 * Plain C (gnu99), no libc linkage: memory functions come from the Host libc
 * extension, decompression from the Host LZ4 extension, buffers from
 * host->alloc. Nothing here blocks or keeps the framebuffer locked across
 * callbacks.
 */
#ifndef HUD_RENDER_H
#define HUD_RENDER_H

#include "gm_plugin.h"
#include "gm_plugin_lvgl_api.h"
#include "gm_plugin_libc.h"
#include "gm_plugin_extensions.h"

#ifdef __cplusplus
extern "C" {
#endif

#define HR_GREY_LEVELS 16U
#define HR_ASSET_SLOTS 16U
#define HR_ASSET_MAX_TILES 32U
#define HR_ASSET_MAX_BYTES 16384U     /* pixel bytes per asset (e.g. 180x180) */
#define HR_FB_SCRATCH_BYTES 16384U    /* largest decoded framebuffer tile */

/* Wire codecs for asset and framebuffer tiles. */
#define HR_CODEC_RAW 0U
#define HR_CODEC_LZ4 1U

/* hr_asset_begin flags. */
#define HR_ASSET_TRANSPARENT_ZERO 0x01U  /* grey level 0 is fully transparent */

/* Results from hr_handle_*: >= 0 is fine. */
#define HR_OK 0
#define HR_PARTIAL 1      /* tile stored, asset not complete yet */
#define HR_COMPLETE 2     /* every tile arrived and the hash matched */
#define HR_ERR_FORMAT -1  /* malformed message */
#define HR_ERR_NOMEM -2
#define HR_ERR_HASH -3    /* all tiles arrived but hash mismatch: resend */
#define HR_ERR_DECODE -4
#define HR_ERR_STATE -5

typedef struct {
    const gm_plugin_host_api_t *host;
    const gm_plugin_lvgl_api_t *ui;
    const gm_plugin_libc_extension_api_t *libc;
    const gm_plugin_lz4_extension_api_t *lz4;   /* optional: RAW still works */
    uint8_t *scratch;                           /* framebuffer tile decode */
} hr_ctx_t;

/* Resolve LVGL, libc (required) and LZ4 (optional). Call from gm_plugin_entry. */
gm_plugin_result_t hr_init(hr_ctx_t *ctx, const gm_plugin_host_api_t *host);
/* Free buffers taken with host->alloc (scratch). Safe to call twice. */
void hr_release(hr_ctx_t *ctx);

/* ---- text and shapes ---------------------------------------------------- */

#define HR_FONT_DEFAULT 0U
#define HR_FONT_LARGE 1U

typedef struct {
    int16_t x, y, w, h;
    uint8_t font;        /* HR_FONT_* */
    uint8_t grey;        /* 0 (black) .. 15 (full green) */
    uint8_t align;       /* GM_PLUGIN_LVGL_TEXT_ALIGN_* */
    uint8_t mode;        /* GM_PLUGIN_LVGL_LABEL_* */
} hr_text_style_t;

/* A label plus a hash of its text, so redraws only happen when text changes. */
typedef struct {
    gm_plugin_lvgl_obj_t *obj;
    uint32_t hash;
    uint8_t hidden;
    uint8_t grey;
} hr_cell_t;

/* 8-bit LVGL colour for a 4-bit grey level. */
static inline uint8_t hr_grey(uint8_t level)
{
    if (level > 15U) level = 15U;
    return (uint8_t)((level << 4) | level);
}

const gm_plugin_lvgl_font_t *hr_font(const hr_ctx_t *ctx, uint8_t font);
gm_plugin_lvgl_obj_t *hr_text(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *parent,
                              const hr_text_style_t *style);
/* Create a cell; returns false on allocation failure. */
bool hr_cell_init(const hr_ctx_t *ctx, hr_cell_t *cell, gm_plugin_lvgl_obj_t *parent,
                  const hr_text_style_t *style);
/* Set text only when it differs from what the cell shows. NULL/"" hides it. */
void hr_cell_set(const hr_ctx_t *ctx, hr_cell_t *cell, const char *utf8);
void hr_cell_grey(const hr_ctx_t *ctx, hr_cell_t *cell, uint8_t grey);
void hr_cell_move(const hr_ctx_t *ctx, hr_cell_t *cell, int16_t x, int16_t y);

/* Rectangle; fill/border grey -1 means none. */
gm_plugin_lvgl_obj_t *hr_box(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *parent,
                             int16_t x, int16_t y, int16_t w, int16_t h,
                             int8_t fill_grey, int8_t border_grey,
                             uint8_t border_width, uint8_t radius);
/* Horizontal rule (a 1..n px box, so no point array has to outlive the call). */
gm_plugin_lvgl_obj_t *hr_hline(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *parent,
                               int16_t x, int16_t y, int16_t w, uint8_t thickness,
                               uint8_t grey);
void hr_show(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *obj, bool visible);

/* ---- assets received over Bluetooth ------------------------------------- */

typedef struct {
    uint8_t *data;                  /* 64-byte BGRA palette + packed pixels */
    gm_plugin_lvgl_image_dsc_t dsc;
    uint32_t capacity;              /* bytes allocated at data */
    uint32_t hash;                  /* FNV-1a of the packed pixels */
    uint32_t tiles_seen;            /* bitmask of received tiles */
    uint16_t width, height, tile_rows, tile_count;
    uint8_t ready;
    uint8_t flags;
} hr_asset_t;

typedef struct {
    hr_asset_t slot[HR_ASSET_SLOTS];
    uint32_t generation;            /* bumps whenever any asset completes */
} hr_assets_t;

void hr_assets_init(hr_assets_t *assets);
void hr_assets_free(const hr_ctx_t *ctx, hr_assets_t *assets);

/* Message bodies (little-endian), embedded in the app's own protocol:
 *
 *   ASSET_BEGIN  slot u8, flags u8, width u16, height u16, tile_rows u16,
 *                hash u32                                       (12 bytes)
 *   ASSET_TILE   slot u8, codec u8, tile u16, raw_len u16, payload...
 *   FB_TILE      codec u8, reserved u8, x u16, y u16, w u16, h u16,
 *                raw_len u16, payload...      (x and w even, GRAY_4 rows)
 *
 * width must be even. A tile covers tile_rows rows (the last may be shorter).
 */
#define HR_ASSET_BEGIN_BYTES 12U
#define HR_ASSET_TILE_HEADER_BYTES 6U
#define HR_FB_TILE_HEADER_BYTES 12U

int hr_handle_asset_begin(const hr_ctx_t *ctx, hr_assets_t *assets,
                          const uint8_t *body, uint32_t length, uint8_t *slot_out);
int hr_handle_asset_tile(const hr_ctx_t *ctx, hr_assets_t *assets,
                         const uint8_t *body, uint32_t length, uint8_t *slot_out);
/* Ready image descriptor for LVGL, or NULL while the asset is missing. */
const gm_plugin_lvgl_image_dsc_t *hr_asset_image(const hr_assets_t *assets, uint8_t slot);
/* Hash of a ready asset (0 when missing), for "what do you already have". */
uint32_t hr_asset_hash(const hr_assets_t *assets, uint8_t slot);

/* Blit one GRAY_4 tile straight into the framebuffer. Do not call while LVGL
 * owns that screen area: a later LVGL redraw overwrites these pixels. */
int hr_handle_fb_tile(hr_ctx_t *ctx, const uint8_t *body, uint32_t length);
/* Lower-level: blit already-decoded packed rows (stride = w/2). */
int hr_fb_blit(const hr_ctx_t *ctx, uint16_t x, uint16_t y, uint16_t w, uint16_t h,
               const uint8_t *packed);

/* ---- helpers ------------------------------------------------------------- */

uint32_t hr_fnv1a(const uint8_t *data, uint32_t length);
uint32_t hr_fnv1a_str(const char *text);

static inline uint16_t hr_u16(const uint8_t *p)
{
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

static inline uint32_t hr_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static inline void hr_put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static inline void hr_put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

#ifdef __cplusplus
}
#endif

#endif
