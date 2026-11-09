/* Minimal fake MemoMind Host for native (macOS/Linux) tests of the glasses
 * plugin: a fake LVGL object tree, libc and LZ4 extensions, the Input
 * extension, a recording bt_send and a controllable clock. */
#ifndef FAKE_HOST_H
#define FAKE_HOST_H

#include "gm_plugin.h"
#include "gm_plugin_extensions.h"
#include "gm_plugin_lvgl_api.h"

#define FAKE_MAX_OBJS 1024
#define FAKE_MAX_SENT 256
#define FAKE_CHAR_W 10      /* every code point is 10 px wide */
#define FAKE_LINE_H 17

typedef struct {
    int used, type, parent, hidden;
    int x, y, w, h;
    int grey;
    char text[1200];
    const gm_plugin_lvgl_image_dsc_t *image;
} fake_obj_t;

enum { FAKE_OBJ = 1, FAKE_LABEL = 2, FAKE_IMAGE = 3 };

typedef struct {
    uint16_t channel;
    uint32_t length;
    uint8_t data[2048];
} fake_msg_t;

extern gm_plugin_host_api_t fake_host;
extern fake_obj_t fake_objs[FAKE_MAX_OBJS];
extern fake_msg_t fake_sent[FAKE_MAX_SENT];
extern int fake_sent_count;
extern uint32_t fake_now;
extern long fake_live_allocs;
extern int fake_input_subscribed;
extern gm_plugin_input_callback_t fake_input_cb;
extern void *fake_input_ctx;
extern int fake_input_available;     /* set 0 before entry to hide the extension */
extern uint8_t fake_fb[350][300];    /* GRAY_4 framebuffer, slices of 175 rows */

void fake_reset(void);
/* Absolute position and visibility of an object (parents included). */
int fake_visible(int index, int *ax, int *ay);
int fake_index(const gm_plugin_lvgl_obj_t *obj);

#endif
