#include "fake_host.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef USE_LIBLZ4
#include <lz4.h>
#endif

fake_obj_t fake_objs[FAKE_MAX_OBJS];
fake_msg_t fake_sent[FAKE_MAX_SENT];
int fake_sent_count;
uint32_t fake_now = 1000;
long fake_live_allocs;
int fake_input_subscribed;
gm_plugin_input_callback_t fake_input_cb;
void *fake_input_ctx;
int fake_input_available = 1;
uint8_t fake_fb[350][300];

static const int s_font_default = 1;
static const int s_font_large = 2;

/* ---- objects ------------------------------------------------------------- */

int fake_index(const gm_plugin_lvgl_obj_t *obj)
{
    long i = (long)(uintptr_t)obj - 1;
    if (obj == NULL || i < 0 || i >= FAKE_MAX_OBJS || !fake_objs[i].used) {
        fprintf(stderr, "fake: bad object %p\n", (const void *)obj);
        abort();
    }
    return (int)i;
}

static gm_plugin_lvgl_obj_t *handle(int i) { return (gm_plugin_lvgl_obj_t *)(uintptr_t)(i + 1); }

static gm_plugin_lvgl_obj_t *create(gm_plugin_lvgl_obj_t *parent, int type)
{
    int i;
    for (i = 1; i < FAKE_MAX_OBJS; ++i) {
        if (!fake_objs[i].used) {
            memset(&fake_objs[i], 0, sizeof(fake_objs[i]));
            fake_objs[i].used = 1;
            fake_objs[i].type = type;
            fake_objs[i].parent = parent ? fake_index(parent) : 0;
            fake_objs[i].grey = -1;
            return handle(i);
        }
    }
    return NULL;
}

int fake_visible(int index, int *ax, int *ay)
{
    int x = 0, y = 0, i = index;
    while (i != 0) {
        if (fake_objs[i].hidden) return 0;
        x += fake_objs[i].x;
        y += fake_objs[i].y;
        i = fake_objs[i].parent;
    }
    if (fake_objs[0].hidden) return 0;
    if (ax) *ax = x;
    if (ay) *ay = y;
    return 1;
}

static gm_plugin_lvgl_obj_t *root_get(void) { return handle(0); }
static gm_plugin_lvgl_obj_t *obj_create(gm_plugin_lvgl_obj_t *p) { return create(p, FAKE_OBJ); }

static void delete_children(int index)
{
    int i;
    for (i = 1; i < FAKE_MAX_OBJS; ++i) {
        if (fake_objs[i].used && fake_objs[i].parent == index) {
            delete_children(i);
            fake_objs[i].used = 0;
        }
    }
}

static void obj_delete(gm_plugin_lvgl_obj_t *o) { int i = fake_index(o); delete_children(i); if (i) fake_objs[i].used = 0; }
static void obj_clean(gm_plugin_lvgl_obj_t *o) { delete_children(fake_index(o)); }
static void obj_set_pos(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_coord_t x, gm_plugin_lvgl_coord_t y)
{
    fake_objs[fake_index(o)].x = x;
    fake_objs[fake_index(o)].y = y;
}
static void obj_set_size(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_coord_t w, gm_plugin_lvgl_coord_t h)
{
    fake_objs[fake_index(o)].w = w;
    fake_objs[fake_index(o)].h = h;
}
static void obj_align(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_align_t a, gm_plugin_lvgl_coord_t x, gm_plugin_lvgl_coord_t y)
{
    (void)a;
    obj_set_pos(o, x, y);
}
static void obj_add_flag(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_flag_t f)
{
    if (f & GM_PLUGIN_LVGL_FLAG_HIDDEN) fake_objs[fake_index(o)].hidden = 1;
}
static void obj_clear_flag(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_flag_t f)
{
    if (f & GM_PLUGIN_LVGL_FLAG_HIDDEN) fake_objs[fake_index(o)].hidden = 0;
}
static void obj_invalidate(const gm_plugin_lvgl_obj_t *o) { (void)fake_index(o); }
static gm_plugin_lvgl_coord_t obj_get_width(const gm_plugin_lvgl_obj_t *o) { return (gm_plugin_lvgl_coord_t)fake_objs[fake_index(o)].w; }
static gm_plugin_lvgl_coord_t obj_get_height(const gm_plugin_lvgl_obj_t *o) { return (gm_plugin_lvgl_coord_t)fake_objs[fake_index(o)].h; }
static void style_set(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_style_prop_t p, gm_plugin_lvgl_style_value_t v, gm_plugin_lvgl_selector_t s)
{
    (void)s;
    if (p == GM_PLUGIN_LVGL_STYLE_TEXT_COLOR) fake_objs[fake_index(o)].grey = v.color.full & 0x0F;
    if (p == GM_PLUGIN_LVGL_STYLE_TEXT_FONT && v.ptr != &s_font_default && v.ptr != &s_font_large) {
        fprintf(stderr, "fake: unknown font pointer\n");
        abort();
    }
}
static gm_plugin_lvgl_obj_t *label_create(gm_plugin_lvgl_obj_t *p) { return create(p, FAKE_LABEL); }
static void label_set_text(gm_plugin_lvgl_obj_t *o, const char *t)
{
    fake_obj_t *obj = &fake_objs[fake_index(o)];
    snprintf(obj->text, sizeof(obj->text), "%s", t ? t : "");
}
static void label_set_long_mode(gm_plugin_lvgl_obj_t *o, gm_plugin_lvgl_label_mode_t m) { (void)o; (void)m; }
static gm_plugin_lvgl_obj_t *arc_create(gm_plugin_lvgl_obj_t *p) { return create(p, FAKE_OBJ); }
static void arc_set_range(gm_plugin_lvgl_obj_t *o, int16_t a, int16_t b) { (void)o; (void)a; (void)b; }
static void arc_set_value(gm_plugin_lvgl_obj_t *o, int16_t v) { (void)o; (void)v; }
static gm_plugin_lvgl_obj_t *line_create(gm_plugin_lvgl_obj_t *p) { return create(p, FAKE_OBJ); }
static void line_set_points(gm_plugin_lvgl_obj_t *o, const gm_plugin_lvgl_point_t *p, uint16_t n) { (void)o; (void)p; (void)n; }
/* FAKE_LINE_H (env) overrides the default font height, to test layouts with tall fonts. */
static gm_plugin_lvgl_coord_t fake_line_h(void)
{
    const char *env = getenv("FAKE_LINE_H");
    int v = env != NULL ? atoi(env) : 0;
    return (gm_plugin_lvgl_coord_t)(v >= 8 && v <= 60 ? v : FAKE_LINE_H);
}
static gm_plugin_lvgl_coord_t font_line_height(const gm_plugin_lvgl_font_t *f)
{
    return (gm_plugin_lvgl_coord_t)(fake_line_h() + (f == (const gm_plugin_lvgl_font_t *)&s_font_large ? 8 : 0));
}

static int cp_len(const char *p)
{
    unsigned char c = (unsigned char)*p;
    return c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1;
}

/* LVGL-like line breaking: break at '\n' (consumed) or at the last space that
 * fits; split long words. Returns bytes in this line including the break. */
static uint32_t next_line(const char *t, const gm_plugin_lvgl_font_t *f, gm_plugin_lvgl_coord_t ls,
                          gm_plugin_lvgl_coord_t max_w, gm_plugin_lvgl_coord_t *used, gm_plugin_lvgl_text_flag_t fl)
{
    int width = 0, i = 0, last_space = -1, width_at_space = 0;
    (void)f; (void)ls; (void)fl;
    while (t[i] != '\0') {
        int n;
        if (t[i] == '\n') { if (used) *used = (gm_plugin_lvgl_coord_t)width; return (uint32_t)i + 1; }
        if (width + FAKE_CHAR_W > max_w) {
            if (last_space >= 0) { if (used) *used = (gm_plugin_lvgl_coord_t)width_at_space; return (uint32_t)last_space + 1; }
            if (i == 0) i = cp_len(t);
            if (used) *used = (gm_plugin_lvgl_coord_t)width;
            return (uint32_t)i;
        }
        if (t[i] == ' ') { last_space = i; width_at_space = width; }
        n = cp_len(t + i);
        width += FAKE_CHAR_W;
        i += n;
    }
    if (used) *used = (gm_plugin_lvgl_coord_t)width;
    return (uint32_t)i;
}

static void text_size(gm_plugin_lvgl_point_t *s, const char *t, const gm_plugin_lvgl_font_t *f, gm_plugin_lvgl_coord_t a,
                      gm_plugin_lvgl_coord_t b, gm_plugin_lvgl_coord_t m, gm_plugin_lvgl_text_flag_t fl)
{
    (void)f; (void)a; (void)b; (void)m; (void)fl;
    s->x = (gm_plugin_lvgl_coord_t)(strlen(t) * FAKE_CHAR_W);
    s->y = fake_line_h();
}
static void sel(gm_plugin_lvgl_obj_t *o, uint32_t i) { (void)o; (void)i; }

static void check_image(const gm_plugin_lvgl_image_dsc_t *d)
{
    if (d == NULL || d->struct_size < GM_PLUGIN_LVGL_IMAGE_DSC_MIN_SIZE ||
        d->format != GM_PLUGIN_LVGL_IMAGE_INDEXED_4BIT || ((uintptr_t)d->data & 3U) != 0 ||
        d->data_size != 64U + (uint32_t)((d->width + 1) / 2) * d->height) {
        fprintf(stderr, "fake: invalid image descriptor\n");
        abort();
    }
}
static gm_plugin_lvgl_obj_t *image_create(gm_plugin_lvgl_obj_t *p, const gm_plugin_lvgl_image_dsc_t *d)
{
    gm_plugin_lvgl_obj_t *o;
    check_image(d);
    o = create(p, FAKE_IMAGE);
    if (o) {
        fake_objs[fake_index(o)].image = d;
        fake_objs[fake_index(o)].w = d->width;
        fake_objs[fake_index(o)].h = d->height;
    }
    return o;
}
static gm_plugin_result_t image_set_source(gm_plugin_lvgl_obj_t *o, const gm_plugin_lvgl_image_dsc_t *d)
{
    check_image(d);
    fake_objs[fake_index(o)].image = d;
    return GM_PLUGIN_OK;
}

static gm_plugin_lvgl_api_t s_lvgl;

/* ---- core host ----------------------------------------------------------- */

static void host_log(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
}
static uint32_t host_now(void) { return fake_now; }
static void *host_alloc(size_t n) { void *p = malloc(n); if (p) fake_live_allocs++; return p; }
static void host_free(void *p) { if (p) { fake_live_allocs--; free(p); } }
static gm_plugin_result_t display_info(gm_plugin_display_info_t *i)
{
    i->width = 600; i->height = 350; i->refresh_hz = 30;
    i->pixel_format = GM_PLUGIN_PIXEL_GRAY_4; i->logical_display_count = 1;
    return GM_PLUGIN_OK;
}
static gm_plugin_result_t bt_send(gm_plugin_bt_channel_t ch, const void *d, uint32_t n)
{
    if (fake_sent_count >= FAKE_MAX_SENT || n > sizeof(fake_sent[0].data)) return GM_PLUGIN_EFULL;
    fake_sent[fake_sent_count].channel = ch;
    fake_sent[fake_sent_count].length = n;
    memcpy(fake_sent[fake_sent_count].data, d, n);
    fake_sent_count++;
    return GM_PLUGIN_OK;
}
static gm_plugin_result_t imu_enable(gm_plugin_imu_modes_t m) { (void)m; return GM_PLUGIN_OK; }

static int s_fb_locked = -1;
static gm_plugin_result_t fb_lock(uint16_t y, gm_plugin_framebuffer_surface_t *s)
{
    uint16_t start = y < 175 ? 0 : 175;
    if (y >= 350 || s_fb_locked >= 0) return GM_PLUGIN_EINVAL;
    s_fb_locked = start;
    s->pixels = &fake_fb[start][0];
    s->y = start; s->width = 600; s->height = 175; s->stride = 300;
    return GM_PLUGIN_OK;
}
static gm_plugin_result_t fb_unlock(const gm_plugin_rect_t *dirty, bool present)
{
    (void)present;
    if (s_fb_locked < 0) return GM_PLUGIN_ESTATE;
    if (dirty && (dirty->y < s_fb_locked || dirty->y + dirty->height > s_fb_locked + 175)) {
        s_fb_locked = -1;
        return GM_PLUGIN_EINVAL;
    }
    s_fb_locked = -1;
    return GM_PLUGIN_OK;
}

/* ---- extensions ---------------------------------------------------------- */

static int32_t lz4_bound(int32_t n) { return n + n / 255 + 16; }
static int32_t lz4_compress(const void *s, void *d, int32_t n, int32_t cap) { (void)s; (void)d; (void)n; (void)cap; return 0; }

#ifdef USE_LIBLZ4
static int32_t lz4_decompress(const void *s, void *d, int32_t n, int32_t cap)
{
    return LZ4_decompress_safe((const char *)s, (char *)d, n, cap);
}
#else
/* Small reference LZ4 block decoder (used when liblz4 is not installed). */
static int32_t lz4_decompress(const void *src, void *dst, int32_t n, int32_t cap)
{
    const uint8_t *ip = src, *iend = ip + n;
    uint8_t *op = dst, *oend = op + cap;
    while (ip < iend) {
        uint8_t token = *ip++;
        uint32_t lit = token >> 4, len, off;
        if (lit == 15) { uint8_t b; do { if (ip >= iend) return -1; b = *ip++; lit += b; } while (b == 255); }
        if ((uint32_t)(iend - ip) < lit || (uint32_t)(oend - op) < lit) return -1;
        memcpy(op, ip, lit); op += lit; ip += lit;
        if (ip >= iend) break;
        if (iend - ip < 2) return -1;
        off = (uint32_t)ip[0] | ((uint32_t)ip[1] << 8); ip += 2;
        if (off == 0 || off > (uint32_t)(op - (uint8_t *)dst)) return -1;
        len = token & 15;
        if (len == 15) { uint8_t b; do { if (ip >= iend) return -1; b = *ip++; len += b; } while (b == 255); }
        len += 4;
        if ((uint32_t)(oend - op) < len) return -1;
        while (len--) { *op = *(op - off); op++; }
    }
    return (int32_t)(op - (uint8_t *)dst);
}
#endif
static const gm_plugin_lz4_extension_api_t s_lz4 = { lz4_bound, lz4_compress, lz4_decompress };

static int f_snprintf(char *b, size_t n, const char *f, ...)
{
    int r; va_list ap; va_start(ap, f); r = vsnprintf(b, n, f, ap); va_end(ap); return r;
}
static char *f_strnstr(const char *h, const char *n, size_t len)
{
    size_t k = strlen(n), i;
    for (i = 0; i + k <= len && h[i]; ++i) if (strncmp(h + i, n, k) == 0) return (char *)(uintptr_t)(h + i);
    return NULL;
}
static gm_plugin_libc_extension_api_t s_libc;

static gm_plugin_result_t input_subscribe(gm_plugin_input_classes_t c, gm_plugin_input_callback_t cb, void *ctx)
{
    if (c == 0 || cb == NULL) return GM_PLUGIN_EINVAL;
    fake_input_subscribed = (int)c;
    fake_input_cb = cb;
    fake_input_ctx = ctx;
    return GM_PLUGIN_OK;
}
static void input_unsubscribe(void) { fake_input_subscribed = 0; fake_input_cb = NULL; }
static const gm_plugin_input_extension_api_t s_input = { input_subscribe, input_unsubscribe };

static gm_plugin_result_t extension_get(uint32_t id, const void **api)
{
    *api = NULL;
    if (id == GM_PLUGIN_EXTENSION_LZ4) { *api = &s_lz4; return GM_PLUGIN_OK; }
    if (id == GM_PLUGIN_EXTENSION_LIBC) { *api = &s_libc; return GM_PLUGIN_OK; }
    if (id == GM_PLUGIN_EXTENSION_INPUT && fake_input_available) { *api = &s_input; return GM_PLUGIN_OK; }
    return GM_PLUGIN_ENOTSUP;
}

gm_plugin_host_api_t fake_host;

void fake_reset(void)
{
    memset(fake_objs, 0, sizeof(fake_objs));
    fake_objs[0].used = 1;  /* root */
    fake_sent_count = 0;
    fake_live_allocs = 0;
    fake_input_subscribed = 0;
    fake_input_cb = NULL;
    memset(fake_fb, 0, sizeof(fake_fb));

    memset(&s_lvgl, 0, sizeof(s_lvgl));
    s_lvgl.struct_size = sizeof(s_lvgl);
    s_lvgl.api_version = GM_PLUGIN_LVGL_API_VERSION;
    s_lvgl.root_get = root_get; s_lvgl.obj_create = obj_create; s_lvgl.obj_delete = obj_delete;
    s_lvgl.obj_clean = obj_clean; s_lvgl.obj_set_pos = obj_set_pos; s_lvgl.obj_set_size = obj_set_size;
    s_lvgl.obj_align = obj_align; s_lvgl.obj_add_flag = obj_add_flag; s_lvgl.obj_clear_flag = obj_clear_flag;
    s_lvgl.obj_invalidate = obj_invalidate; s_lvgl.obj_get_width = obj_get_width;
    s_lvgl.obj_get_height = obj_get_height; s_lvgl.style_set = style_set;
    s_lvgl.label_create = label_create; s_lvgl.label_set_text = label_set_text;
    s_lvgl.label_set_long_mode = label_set_long_mode; s_lvgl.arc_create = arc_create;
    s_lvgl.arc_set_range = arc_set_range; s_lvgl.arc_set_value = arc_set_value;
    s_lvgl.line_create = line_create; s_lvgl.line_set_points = line_set_points;
    s_lvgl.font_default = (const gm_plugin_lvgl_font_t *)&s_font_default;
    s_lvgl.font_large = (const gm_plugin_lvgl_font_t *)&s_font_large;
    s_lvgl.font_get_line_height = font_line_height; s_lvgl.text_get_size = text_size;
    s_lvgl.text_get_next_line = next_line; s_lvgl.label_set_selection_start = sel;
    s_lvgl.label_set_selection_end = sel; s_lvgl.image_create = image_create;
    s_lvgl.image_set_source = image_set_source;

    memset(&s_libc, 0, sizeof(s_libc));
    s_libc.memcpy = memcpy; s_libc.memmove = memmove; s_libc.memset = memset;
    s_libc.memcmp = memcmp; s_libc.memchr = memchr; s_libc.strlen = strlen;
    s_libc.strnlen = strnlen; s_libc.strcpy = strcpy; s_libc.strncpy = strncpy;
    s_libc.strcat = strcat; s_libc.strncat = strncat; s_libc.strcmp = strcmp;
    s_libc.strncmp = strncmp; s_libc.strchr = strchr; s_libc.strrchr = strrchr;
    s_libc.strstr = strstr; s_libc.strnstr = f_strnstr; s_libc.strspn = strspn;
    s_libc.strcspn = strcspn; s_libc.strpbrk = strpbrk; s_libc.strtok_r = strtok_r;
    s_libc.snprintf = f_snprintf; s_libc.vsnprintf = vsnprintf;

    memset(&fake_host, 0, sizeof(fake_host));
    fake_host.struct_size = sizeof(fake_host);
    fake_host.abi_version = GM_PLUGIN_ABI_VERSION;
    fake_host.log = host_log;
    fake_host.monotonic_ms = host_now;
    fake_host.alloc = host_alloc;
    fake_host.free = host_free;
    fake_host.display_get_info = display_info;
    fake_host.graphics.lvgl = &s_lvgl;
    fake_host.graphics.framebuffer.lock = fb_lock;
    fake_host.graphics.framebuffer.unlock = fb_unlock;
    fake_host.bt_send = bt_send;
    fake_host.imu_enable = imu_enable;
    fake_host.extension_get = extension_get;
}
