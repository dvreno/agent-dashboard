#include "hud_render.h"

#define PALETTE_BYTES 64U

uint32_t hr_fnv1a(const uint8_t *data, uint32_t length)
{
    uint32_t hash = 2166136261U;
    uint32_t i;
    for (i = 0; i < length; ++i) {
        hash ^= data[i];
        hash *= 16777619U;
    }
    return hash;
}

uint32_t hr_fnv1a_str(const char *text)
{
    uint32_t hash = 2166136261U;
    if (text == 0) return 0U;
    while (*text != '\0') {
        hash ^= (uint8_t)*text++;
        hash *= 16777619U;
    }
    return hash;
}

gm_plugin_result_t hr_init(hr_ctx_t *ctx, const gm_plugin_host_api_t *host)
{
    const void *api = 0;
    gm_plugin_result_t result;
    if (ctx == 0 || host == 0) return GM_PLUGIN_EINVAL;
    ctx->host = host;
    ctx->ui = host->graphics.lvgl;
    ctx->libc = 0;
    ctx->lz4 = 0;
    ctx->scratch = 0;
    if (ctx->ui == 0) return GM_PLUGIN_ENOTSUP;
    result = gm_plugin_libc_get(host, &ctx->libc);
    if (result != GM_PLUGIN_OK) return result;
    if (host->extension_get != 0 &&
        host->extension_get(GM_PLUGIN_EXTENSION_LZ4, &api) == GM_PLUGIN_OK && api != 0) {
        const gm_plugin_lz4_extension_api_t *lz4 = api;
        if (lz4->decompress_safe != 0) ctx->lz4 = lz4;
    }
    return GM_PLUGIN_OK;
}

void hr_release(hr_ctx_t *ctx)
{
    if (ctx == 0 || ctx->host == 0) return;
    if (ctx->scratch != 0) ctx->host->free(ctx->scratch);
    ctx->scratch = 0;
}

/* ---- text and shapes ---------------------------------------------------- */

static gm_plugin_lvgl_style_value_t num(int32_t value)
{
    return gm_plugin_lvgl_style_number(value);
}

static void style(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *obj,
                  gm_plugin_lvgl_style_prop_t prop, gm_plugin_lvgl_style_value_t value)
{
    ctx->ui->style_set(obj, prop, value, GM_PLUGIN_LVGL_SELECTOR_MAIN);
}

const gm_plugin_lvgl_font_t *hr_font(const hr_ctx_t *ctx, uint8_t font)
{
    if (font == HR_FONT_LARGE && ctx->ui->font_large != 0) return ctx->ui->font_large;
    return ctx->ui->font_default;
}

gm_plugin_lvgl_obj_t *hr_text(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *parent,
                              const hr_text_style_t *s)
{
    gm_plugin_lvgl_obj_t *label = ctx->ui->label_create(parent);
    gm_plugin_lvgl_style_value_t font;
    if (label == 0) return 0;
    ctx->ui->label_set_long_mode(label, s->mode);
    ctx->ui->obj_set_pos(label, s->x, s->y);
    ctx->ui->obj_set_size(label, s->w, s->h);
    font.ptr = hr_font(ctx, s->font);
    style(ctx, label, GM_PLUGIN_LVGL_STYLE_TEXT_FONT, font);
    style(ctx, label, GM_PLUGIN_LVGL_STYLE_TEXT_COLOR, gm_plugin_lvgl_style_color(hr_grey(s->grey)));
    style(ctx, label, GM_PLUGIN_LVGL_STYLE_TEXT_ALIGN, num(s->align));
    ctx->ui->label_set_text(label, "");
    return label;
}

bool hr_cell_init(const hr_ctx_t *ctx, hr_cell_t *cell, gm_plugin_lvgl_obj_t *parent,
                  const hr_text_style_t *s)
{
    cell->obj = hr_text(ctx, parent, s);
    cell->hash = hr_fnv1a_str("");
    cell->hidden = 0U;
    cell->grey = s->grey;
    return cell->obj != 0;
}

void hr_cell_set(const hr_ctx_t *ctx, hr_cell_t *cell, const char *utf8)
{
    uint32_t hash;
    bool empty = utf8 == 0 || utf8[0] == '\0';
    if (cell->obj == 0) return;
    if (empty) {
        if (cell->hidden == 0U) {
            ctx->ui->obj_add_flag(cell->obj, GM_PLUGIN_LVGL_FLAG_HIDDEN);
            cell->hidden = 1U;
        }
        return;
    }
    hash = hr_fnv1a_str(utf8);
    if (hash != cell->hash) {
        ctx->ui->label_set_text(cell->obj, utf8);
        cell->hash = hash;
    }
    if (cell->hidden != 0U) {
        ctx->ui->obj_clear_flag(cell->obj, GM_PLUGIN_LVGL_FLAG_HIDDEN);
        cell->hidden = 0U;
    }
}

void hr_cell_grey(const hr_ctx_t *ctx, hr_cell_t *cell, uint8_t grey)
{
    if (cell->obj == 0 || cell->grey == grey) return;
    cell->grey = grey;
    style(ctx, cell->obj, GM_PLUGIN_LVGL_STYLE_TEXT_COLOR,
          gm_plugin_lvgl_style_color(hr_grey(grey)));
}

void hr_cell_move(const hr_ctx_t *ctx, hr_cell_t *cell, int16_t x, int16_t y)
{
    if (cell->obj != 0) ctx->ui->obj_set_pos(cell->obj, x, y);
}

gm_plugin_lvgl_obj_t *hr_box(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *parent,
                             int16_t x, int16_t y, int16_t w, int16_t h,
                             int8_t fill_grey, int8_t border_grey,
                             uint8_t border_width, uint8_t radius)
{
    gm_plugin_lvgl_obj_t *box = ctx->ui->obj_create(parent);
    if (box == 0) return 0;
    ctx->ui->obj_clear_flag(box, GM_PLUGIN_LVGL_FLAG_SCROLLABLE);
    ctx->ui->obj_set_pos(box, x, y);
    ctx->ui->obj_set_size(box, w, h);
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_PAD_TOP, num(0));
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_PAD_BOTTOM, num(0));
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_PAD_LEFT, num(0));
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_PAD_RIGHT, num(0));
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_RADIUS, num(radius));
    if (fill_grey >= 0) {
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BG_COLOR,
              gm_plugin_lvgl_style_color(hr_grey((uint8_t)fill_grey)));
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BG_OPA, num(GM_PLUGIN_LVGL_OPA_COVER));
    } else {
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BG_OPA, num(GM_PLUGIN_LVGL_OPA_TRANSPARENT));
    }
    if (border_grey >= 0 && border_width > 0U) {
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BORDER_COLOR,
              gm_plugin_lvgl_style_color(hr_grey((uint8_t)border_grey)));
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BORDER_WIDTH, num(border_width));
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BORDER_OPA, num(GM_PLUGIN_LVGL_OPA_COVER));
    } else {
        style(ctx, box, GM_PLUGIN_LVGL_STYLE_BORDER_WIDTH, num(0));
    }
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_SHADOW_WIDTH, num(0));
    style(ctx, box, GM_PLUGIN_LVGL_STYLE_OUTLINE_WIDTH, num(0));
    return box;
}

gm_plugin_lvgl_obj_t *hr_hline(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *parent,
                               int16_t x, int16_t y, int16_t w, uint8_t thickness,
                               uint8_t grey)
{
    return hr_box(ctx, parent, x, y, w, (int16_t)(thickness ? thickness : 1U),
                  (int8_t)grey, -1, 0U, 0U);
}

void hr_show(const hr_ctx_t *ctx, gm_plugin_lvgl_obj_t *obj, bool visible)
{
    if (obj == 0) return;
    if (visible) ctx->ui->obj_clear_flag(obj, GM_PLUGIN_LVGL_FLAG_HIDDEN);
    else ctx->ui->obj_add_flag(obj, GM_PLUGIN_LVGL_FLAG_HIDDEN);
}

/* ---- assets -------------------------------------------------------------- */

void hr_assets_init(hr_assets_t *assets)
{
    uint32_t i;
    uint8_t *bytes = (uint8_t *)assets;
    for (i = 0; i < sizeof(*assets); ++i) bytes[i] = 0;
}

void hr_assets_free(const hr_ctx_t *ctx, hr_assets_t *assets)
{
    uint32_t i;
    for (i = 0; i < HR_ASSET_SLOTS; ++i) {
        if (assets->slot[i].data != 0 && ctx->host != 0) ctx->host->free(assets->slot[i].data);
        assets->slot[i].data = 0;
        assets->slot[i].capacity = 0;
        assets->slot[i].ready = 0;
    }
}

static void write_palette(uint8_t *palette, uint8_t flags)
{
    uint32_t i;
    for (i = 0; i < HR_GREY_LEVELS; ++i) {
        uint8_t v = (uint8_t)(i * 17U);
        palette[i * 4U + 0U] = v;  /* B */
        palette[i * 4U + 1U] = v;  /* G */
        palette[i * 4U + 2U] = v;  /* R */
        palette[i * 4U + 3U] = (i == 0U && (flags & HR_ASSET_TRANSPARENT_ZERO)) ? 0U : 0xFFU;
    }
}

int hr_handle_asset_begin(const hr_ctx_t *ctx, hr_assets_t *assets,
                          const uint8_t *body, uint32_t length, uint8_t *slot_out)
{
    hr_asset_t *asset;
    uint8_t slot;
    uint16_t width, height, tile_rows;
    uint32_t pixels, needed;
    if (length < HR_ASSET_BEGIN_BYTES) return HR_ERR_FORMAT;
    slot = body[0];
    width = hr_u16(body + 2);
    height = hr_u16(body + 4);
    tile_rows = hr_u16(body + 6);
    if (slot >= HR_ASSET_SLOTS || width == 0U || height == 0U || (width & 1U) != 0U ||
        tile_rows == 0U)
        return HR_ERR_FORMAT;
    pixels = (uint32_t)(width / 2U) * height;
    if (pixels > HR_ASSET_MAX_BYTES) return HR_ERR_FORMAT;
    if ((uint32_t)((height + tile_rows - 1U) / tile_rows) > HR_ASSET_MAX_TILES)
        return HR_ERR_FORMAT;
    if (slot_out != 0) *slot_out = slot;
    asset = &assets->slot[slot];
    needed = PALETTE_BYTES + pixels;
    if (asset->capacity < needed) {
        /* host->alloc returns memory suitably aligned for any object, which
         * satisfies the 4-byte alignment LVGL needs for indexed images. */
        if (asset->data != 0) ctx->host->free(asset->data);
        asset->data = ctx->host->alloc(needed);
        asset->capacity = asset->data != 0 ? needed : 0U;
        if (asset->data == 0) return HR_ERR_NOMEM;
    }
    asset->flags = body[1];
    asset->width = width;
    asset->height = height;
    asset->tile_rows = tile_rows;
    asset->tile_count = (uint16_t)((height + tile_rows - 1U) / tile_rows);
    asset->hash = hr_u32(body + 8);
    asset->tiles_seen = 0U;
    asset->ready = 0U;
    write_palette(asset->data, asset->flags);
    ctx->libc->memset(asset->data + PALETTE_BYTES, 0, pixels);
    asset->dsc.struct_size = (uint16_t)sizeof(asset->dsc);
    asset->dsc.width = width;
    asset->dsc.height = height;
    asset->dsc.format = GM_PLUGIN_LVGL_IMAGE_INDEXED_4BIT;
    asset->dsc.reserved = 0U;
    asset->dsc.data = asset->data;
    asset->dsc.data_size = needed;
    return HR_OK;
}

static int decode(const hr_ctx_t *ctx, uint8_t codec, const uint8_t *src, uint32_t src_len,
                  uint8_t *dst, uint32_t raw_len)
{
    if (codec == HR_CODEC_RAW) {
        if (src_len != raw_len) return HR_ERR_FORMAT;
        ctx->libc->memcpy(dst, src, raw_len);
        return HR_OK;
    }
    if (codec != HR_CODEC_LZ4) return HR_ERR_FORMAT;
    if (ctx->lz4 == 0) return HR_ERR_STATE;
    if (ctx->lz4->decompress_safe(src, dst, (int32_t)src_len, (int32_t)raw_len) != (int32_t)raw_len)
        return HR_ERR_DECODE;
    return HR_OK;
}

int hr_handle_asset_tile(const hr_ctx_t *ctx, hr_assets_t *assets,
                         const uint8_t *body, uint32_t length, uint8_t *slot_out)
{
    hr_asset_t *asset;
    uint8_t slot, codec;
    uint16_t tile, raw_len, rows, first_row, stride;
    uint32_t all, pixels;
    int result;
    if (length < HR_ASSET_TILE_HEADER_BYTES) return HR_ERR_FORMAT;
    slot = body[0];
    codec = body[1];
    tile = hr_u16(body + 2);
    raw_len = hr_u16(body + 4);
    if (slot >= HR_ASSET_SLOTS) return HR_ERR_FORMAT;
    if (slot_out != 0) *slot_out = slot;
    asset = &assets->slot[slot];
    if (asset->data == 0 || asset->tile_count == 0U) return HR_ERR_STATE;
    if (tile >= asset->tile_count) return HR_ERR_FORMAT;
    stride = (uint16_t)(asset->width / 2U);
    first_row = (uint16_t)(tile * asset->tile_rows);
    rows = asset->tile_rows;
    if ((uint32_t)first_row + rows > asset->height) rows = (uint16_t)(asset->height - first_row);
    if ((uint32_t)rows * stride != raw_len) return HR_ERR_FORMAT;
    result = decode(ctx, codec, body + HR_ASSET_TILE_HEADER_BYTES,
                    length - HR_ASSET_TILE_HEADER_BYTES,
                    asset->data + PALETTE_BYTES + (uint32_t)first_row * stride, raw_len);
    if (result != HR_OK) return result;
    asset->tiles_seen |= (uint32_t)1U << tile;
    all = asset->tile_count >= 32U ? 0xFFFFFFFFU : (((uint32_t)1U << asset->tile_count) - 1U);
    if ((asset->tiles_seen & all) != all) return HR_PARTIAL;
    pixels = (uint32_t)stride * asset->height;
    if (hr_fnv1a(asset->data + PALETTE_BYTES, pixels) != asset->hash) {
        asset->tiles_seen = 0U;
        asset->ready = 0U;
        return HR_ERR_HASH;
    }
    asset->ready = 1U;
    assets->generation++;
    return HR_COMPLETE;
}

const gm_plugin_lvgl_image_dsc_t *hr_asset_image(const hr_assets_t *assets, uint8_t slot)
{
    if (slot >= HR_ASSET_SLOTS || assets->slot[slot].ready == 0U) return 0;
    return &assets->slot[slot].dsc;
}

uint32_t hr_asset_hash(const hr_assets_t *assets, uint8_t slot)
{
    if (slot >= HR_ASSET_SLOTS || assets->slot[slot].ready == 0U) return 0U;
    return assets->slot[slot].hash;
}

/* ---- framebuffer tiles --------------------------------------------------- */

int hr_fb_blit(const hr_ctx_t *ctx, uint16_t x, uint16_t y, uint16_t w, uint16_t h,
               const uint8_t *packed)
{
    const gm_plugin_framebuffer_api_t *fb = &ctx->host->graphics.framebuffer;
    gm_plugin_display_info_t info;
    uint16_t row = y;
    uint16_t end;
    uint16_t stride = (uint16_t)(w / 2U);
    if ((x & 1U) != 0U || (w & 1U) != 0U || w == 0U || h == 0U) return HR_ERR_FORMAT;
    if (fb->lock == 0 || fb->unlock == 0) return HR_ERR_STATE;
    if (ctx->host->display_get_info == 0 ||
        ctx->host->display_get_info(&info) != GM_PLUGIN_OK) return HR_ERR_STATE;
    if ((uint32_t)x + w > info.width || (uint32_t)y + h > info.height) return HR_ERR_FORMAT;
    end = (uint16_t)(y + h);
    while (row < end) {
        gm_plugin_framebuffer_surface_t surface;
        gm_plugin_rect_t dirty;
        uint16_t slice_end, r;
        if (fb->lock(row, &surface) != GM_PLUGIN_OK) return HR_ERR_STATE;
        slice_end = (uint16_t)(surface.y + surface.height);
        if (slice_end > end) slice_end = end;
        for (r = row; r < slice_end; ++r)
            ctx->libc->memcpy(surface.pixels + (uint32_t)(r - surface.y) * surface.stride + x / 2U,
                              packed + (uint32_t)(r - y) * stride, stride);
        dirty.x = (int16_t)x;
        dirty.y = (int16_t)row;
        dirty.width = w;
        dirty.height = (uint16_t)(slice_end - row);
        (void)fb->unlock(&dirty, slice_end == end);
        row = slice_end;
    }
    return HR_OK;
}

int hr_handle_fb_tile(hr_ctx_t *ctx, const uint8_t *body, uint32_t length)
{
    uint16_t x, y, w, h, raw_len;
    uint8_t codec;
    int result;
    if (length < HR_FB_TILE_HEADER_BYTES) return HR_ERR_FORMAT;
    codec = body[0];
    x = hr_u16(body + 2);
    y = hr_u16(body + 4);
    w = hr_u16(body + 6);
    h = hr_u16(body + 8);
    raw_len = hr_u16(body + 10);
    if ((uint32_t)(w / 2U) * h != raw_len || raw_len > HR_FB_SCRATCH_BYTES) return HR_ERR_FORMAT;
    if (ctx->scratch == 0) {
        ctx->scratch = ctx->host->alloc(HR_FB_SCRATCH_BYTES);
        if (ctx->scratch == 0) return HR_ERR_NOMEM;
    }
    result = decode(ctx, codec, body + HR_FB_TILE_HEADER_BYTES, length - HR_FB_TILE_HEADER_BYTES,
                    ctx->scratch, raw_len);
    if (result != HR_OK) return result;
    return hr_fb_blit(ctx, x, y, w, h, ctx->scratch);
}
