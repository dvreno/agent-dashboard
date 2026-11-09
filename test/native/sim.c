/* Line-driven simulator for the Agent Dashboard glasses plugin.
 *
 * Reads commands on stdin, answers on stdout; every answer ends with ".".
 * Used by test/native-hud.test.mjs so the phone-side encoder (native-link.js)
 * can drive the real C plugin. Commands:
 *
 *   start | stop                       lifecycle (stop also reports leaks)
 *   down <hex>                         message on the phone->glasses channel
 *   button single|double|long          glasses button
 *   gesture nod|shake|left|right|raise|lower
 *   nav up|down|left|right|page_up|page_down|scroll_up|scroll_down|back|home
 *   key <gm_plugin_input_key> [repeat] raw HOGP key (needs the subscription)
 *   wheel <value>                      raw HOGP wheel
 *   touch <gm_plugin_input_key>        raw HOGP touch gesture
 *   connect 0|1                        phone link state
 *   time <ms>                          advance the clock, running on_loop
 *   screen                             dump visible labels/images
 *   sent                               dump and clear messages to the phone
 *   suspend | resume
 *   fb <y>                             dump one framebuffer row as hex
 */
#include "fake_host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern gm_plugin_result_t gm_plugin_entry(const gm_plugin_host_api_t *host,
                                          gm_plugin_descriptor_t *plugin);

static gm_plugin_descriptor_t s_plugin;
static int s_started;

static void send_event(gm_plugin_event_t *e)
{
    e->struct_size = sizeof(*e);
    e->timestamp_ms = fake_now;
    if (s_plugin.on_event) (void)s_plugin.on_event(s_plugin.context, e);
}

static void advance(uint32_t ms)
{
    while (ms > 0) {
        uint32_t step = ms > 20 ? 20 : ms;
        fake_now += step;
        ms -= step;
        if (s_started && s_plugin.on_loop) s_plugin.on_loop(s_plugin.context, step);
    }
}

static int hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void print_escaped(const char *s)
{
    for (; *s; ++s) {
        if (*s == '\n') fputs("\\n", stdout);
        else if (*s == '\\') fputs("\\\\", stdout);
        else putchar(*s);
    }
}

typedef struct { int y, x, index; } item_t;

static int by_pos(const void *a, const void *b)
{
    const item_t *p = a, *q = b;
    return p->y != q->y ? p->y - q->y : p->x != q->x ? p->x - q->x : p->index - q->index;
}

static void dump_screen(void)
{
    static item_t items[FAKE_MAX_OBJS];
    int i, n = 0;
    for (i = 1; i < FAKE_MAX_OBJS; ++i) {
        int x, y;
        if (!fake_objs[i].used || !fake_visible(i, &x, &y)) continue;
        if (fake_objs[i].type == FAKE_LABEL && fake_objs[i].text[0] == '\0') continue;
        if (fake_objs[i].type == FAKE_OBJ) continue;
        items[n].x = x; items[n].y = y; items[n].index = i; n++;
    }
    qsort(items, (size_t)n, sizeof(items[0]), by_pos);
    for (i = 0; i < n; ++i) {
        fake_obj_t *o = &fake_objs[items[i].index];
        if (o->type == FAKE_LABEL) {
            printf("L %d %d %d ", items[i].y, items[i].x, o->grey);
            print_escaped(o->text);
            putchar('\n');
        } else {
            const uint8_t *d = o->image->data + 64;
            uint32_t h = 2166136261U, k, len = o->image->data_size - 64;
            for (k = 0; k < len; ++k) { h ^= d[k]; h *= 16777619U; }
            printf("I %d %d %ux%u %08x\n", items[i].y, items[i].x, o->image->width, o->image->height, h);
        }
    }
}

static gm_plugin_button_t button_named(const char *s)
{
    static const char *names[] = { "", "primary", "up", "down", "left", "right", "page_up",
                                   "page_down", "scroll_up", "scroll_down", "back", "home" };
    int i;
    for (i = 1; i < 12; ++i) if (strcmp(s, names[i]) == 0) return (gm_plugin_button_t)i;
    return 0;
}

static void raw(uint8_t key, uint8_t phase, uint8_t source, int32_t value)
{
    gm_plugin_input_event_t e;
    memset(&e, 0, sizeof(e));
    e.struct_size = sizeof(e);
    e.key = key;
    e.phase = phase;
    e.source = source;
    e.value = value;
    e.timestamp_ms = fake_now;
    if (fake_input_cb) fake_input_cb(fake_input_ctx, &e);
    else printf("E no input subscription\n");
}

int main(void)
{
    char line[20000];
    fake_reset();
    setvbuf(stdout, NULL, _IOFBF, 1 << 16);
    while (fgets(line, sizeof(line), stdin)) {
        char cmd[32] = "", a1[20000] = "", a2[64] = "";
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
        sscanf(line, "%31s %19999s %63s", cmd, a1, a2);
        if (strcmp(cmd, "start") == 0) {
            gm_plugin_result_t r;
            memset(&s_plugin, 0, sizeof(s_plugin));
            s_plugin.struct_size = sizeof(s_plugin);
            r = gm_plugin_entry(&fake_host, &s_plugin);
            if (r == GM_PLUGIN_OK && s_plugin.on_load) r = s_plugin.on_load(s_plugin.context);
            if (r == GM_PLUGIN_OK && s_plugin.on_start) r = s_plugin.on_start(s_plugin.context);
            s_started = r == GM_PLUGIN_OK;
            printf("R %d\n", r);
        } else if (strcmp(cmd, "stop") == 0) {
            if (s_plugin.on_stop) s_plugin.on_stop(s_plugin.context);
            if (s_plugin.on_unload) s_plugin.on_unload(s_plugin.context);
            s_started = 0;
            printf("LEAKS %ld\nINPUT %d\n", fake_live_allocs, fake_input_subscribed);
        } else if (strcmp(cmd, "suspend") == 0) {
            if (s_plugin.on_suspend) s_plugin.on_suspend(s_plugin.context);
            printf("INPUT %d\n", fake_input_subscribed);
        } else if (strcmp(cmd, "resume") == 0) {
            if (s_plugin.on_resume) s_plugin.on_resume(s_plugin.context);
            printf("INPUT %d\n", fake_input_subscribed);
        } else if (strcmp(cmd, "down") == 0) {
            static uint8_t buf[10000];
            size_t len = strlen(a1) / 2, i;
            gm_plugin_event_t e;
            for (i = 0; i < len; ++i) buf[i] = (uint8_t)(hexval(a1[2 * i]) * 16 + hexval(a1[2 * i + 1]));
            memset(&e, 0, sizeof(e));
            e.type = GM_PLUGIN_EVENT_BT_MESSAGE;
            e.data.bt.channel = (uint16_t)(a2[0] ? strtoul(a2, NULL, 0) : 0x4144);
            e.data.bt.data = buf;
            e.data.bt.length = (uint32_t)len;
            send_event(&e);
        } else if (strcmp(cmd, "button") == 0) {
            gm_plugin_event_t e;
            memset(&e, 0, sizeof(e));
            e.type = GM_PLUGIN_EVENT_BUTTON;
            e.data.button.button = GM_PLUGIN_BUTTON_PRIMARY;
            e.data.button.action = strcmp(a1, "double") == 0 ? GM_PLUGIN_BUTTON_ACTION_DOUBLE :
                                   strcmp(a1, "long") == 0 ? GM_PLUGIN_BUTTON_ACTION_LONG :
                                   GM_PLUGIN_BUTTON_ACTION_SINGLE;
            send_event(&e);
        } else if (strcmp(cmd, "nav") == 0) {
            gm_plugin_event_t e;
            memset(&e, 0, sizeof(e));
            e.type = GM_PLUGIN_EVENT_BUTTON;
            e.data.button.button = button_named(a1);
            e.data.button.action = GM_PLUGIN_BUTTON_ACTION_TRIGGER;
            send_event(&e);
        } else if (strcmp(cmd, "gesture") == 0) {
            gm_plugin_event_t e;
            memset(&e, 0, sizeof(e));
            e.type = GM_PLUGIN_EVENT_IMU_GESTURE;
            e.data.imu_gesture.active = true;
            e.data.imu_gesture.gesture =
                strcmp(a1, "nod") == 0 ? GM_PLUGIN_IMU_GESTURE_NOD :
                strcmp(a1, "shake") == 0 ? GM_PLUGIN_IMU_GESTURE_SHAKE :
                strcmp(a1, "left") == 0 ? GM_PLUGIN_IMU_GESTURE_LEFT :
                strcmp(a1, "right") == 0 ? GM_PLUGIN_IMU_GESTURE_RIGHT :
                strcmp(a1, "raise") == 0 ? GM_PLUGIN_IMU_GESTURE_HEAD_RAISE :
                GM_PLUGIN_IMU_GESTURE_HEAD_LOWER;
            send_event(&e);
        } else if (strcmp(cmd, "key") == 0) {
            raw((uint8_t)atoi(a1), strcmp(a2, "repeat") == 0 ? GM_PLUGIN_INPUT_PHASE_REPEAT :
                strcmp(a2, "up") == 0 ? GM_PLUGIN_INPUT_PHASE_UP : GM_PLUGIN_INPUT_PHASE_DOWN,
                GM_PLUGIN_INPUT_SOURCE_MOUSE, 0);
        } else if (strcmp(cmd, "wheel") == 0) {
            raw(GM_PLUGIN_INPUT_KEY_REL_WHEEL, GM_PLUGIN_INPUT_PHASE_MOVE, GM_PLUGIN_INPUT_SOURCE_MOUSE, atoi(a1));
        } else if (strcmp(cmd, "touch") == 0) {
            raw((uint8_t)atoi(a1), GM_PLUGIN_INPUT_PHASE_DOWN, GM_PLUGIN_INPUT_SOURCE_DIGITIZER, 0);
        } else if (strcmp(cmd, "connect") == 0) {
            gm_plugin_event_t e;
            memset(&e, 0, sizeof(e));
            e.type = GM_PLUGIN_EVENT_CONNECTION;
            e.data.connection.connected = atoi(a1) != 0;
            send_event(&e);
        } else if (strcmp(cmd, "time") == 0) {
            advance((uint32_t)strtoul(a1, NULL, 10));
        } else if (strcmp(cmd, "screen") == 0) {
            dump_screen();
        } else if (strcmp(cmd, "sent") == 0) {
            int i;
            uint32_t k;
            for (i = 0; i < fake_sent_count; ++i) {
                printf("S %u ", fake_sent[i].channel);
                for (k = 0; k < fake_sent[i].length; ++k) printf("%02x", fake_sent[i].data[k]);
                putchar('\n');
            }
            fake_sent_count = 0;
        } else if (strcmp(cmd, "fb") == 0) {
            int y = atoi(a1), k;
            printf("F ");
            for (k = 0; k < 300; ++k) printf("%02x", fake_fb[y][k]);
            putchar('\n');
        } else if (cmd[0] != '\0') {
            printf("E unknown command %s\n", cmd);
        }
        puts(".");
        fflush(stdout);
    }
    return 0;
}
