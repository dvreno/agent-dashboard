/*
 * hud_input: one input API for MemoMind glasses plugins.
 *
 * It turns the three ways a wearer can give input into one stream of
 * normalized inputs, then maps each input to an app-defined action:
 *
 *   - the single glasses button (single / double click),
 *   - head gestures from the IMU (nod, shake, left, right, raise, lower),
 *   - HOGP accessories such as ring mice, remotes and keyboards, either as the
 *     Host's cooked navigation buttons or as raw events from Input extension 4
 *     (keys, mouse buttons, wheel, touch swipes, media keys).
 *
 * The library is self-contained C (gnu99, no libc, no allocation) so it can be
 * reused by other plugins. Apps keep the policy: they fill a keymap from
 * hi_input_t to their own action numbers and receive actions in a callback.
 *
 * Usage:
 *   hi_init(&in, host, emit, app);         // in gm_plugin_entry or on_load
 *   hi_map(&in, HI_IN_HEAD_NOD, ACT_YES);  // ... and the rest of your keymap
 *   hi_start(&in);                         // on_start / on_resume
 *   if (hi_on_event(&in, event)) return true;  // from on_event
 *   hi_stop(&in);                          // on_suspend / on_stop
 */
#ifndef HUD_INPUT_H
#define HUD_INPUT_H

#include "gm_plugin.h"
#include "gm_plugin_input.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Normalized inputs. Append only: phones may send keymaps by number. */
typedef uint8_t hi_input_t;
enum {
    HI_IN_NONE = 0,
    HI_IN_BUTTON_SINGLE = 1,   /* glasses button, or ring key mapped to it */
    HI_IN_BUTTON_DOUBLE = 2,
    HI_IN_HEAD_NOD = 3,
    HI_IN_HEAD_SHAKE = 4,
    HI_IN_HEAD_LEFT = 5,
    HI_IN_HEAD_RIGHT = 6,
    HI_IN_HEAD_RAISE = 7,
    HI_IN_HEAD_LOWER = 8,
    HI_IN_NAV_UP = 9,
    HI_IN_NAV_DOWN = 10,
    HI_IN_NAV_LEFT = 11,
    HI_IN_NAV_RIGHT = 12,
    HI_IN_NAV_PAGE_UP = 13,
    HI_IN_NAV_PAGE_DOWN = 14,
    HI_IN_NAV_SELECT = 15,
    HI_IN_NAV_BACK = 16,
    HI_IN_NAV_HOME = 17,
    HI_IN_NAV_MENU = 18,
    HI_IN_MEDIA_PLAY_PAUSE = 19,
    HI_IN_MEDIA_NEXT = 20,
    HI_IN_MEDIA_PREV = 21,
    HI_IN_VOLUME_UP = 22,
    HI_IN_VOLUME_DOWN = 23,
    HI_IN_WHEEL_UP = 24,       /* one notch of scroll wheel or scroll key */
    HI_IN_WHEEL_DOWN = 25,
    HI_IN_SWIPE_UP = 26,
    HI_IN_SWIPE_DOWN = 27,
    HI_IN_SWIPE_LEFT = 28,
    HI_IN_SWIPE_RIGHT = 29,
    HI_IN_TAP = 30,
    HI_IN_DOUBLE_TAP = 31,
    HI_IN_MOUSE_LEFT = 32,
    HI_IN_MOUSE_RIGHT = 33,
    HI_IN_MOUSE_MIDDLE = 34,
    HI_IN_GAMEPAD_A = 35,
    HI_IN_GAMEPAD_B = 36,
    HI_IN_GAMEPAD_X = 37,
    HI_IN_GAMEPAD_Y = 38,
    HI_IN_GAMEPAD_L1 = 39,
    HI_IN_GAMEPAD_R1 = 40,
    HI_IN_AI_TRIGGER = 41,
    HI_IN_COUNT = 42
};

/* Where an input came from, for hints like "ring connected". */
typedef uint8_t hi_source_t;
enum {
    HI_SRC_NONE = 0,
    HI_SRC_BUTTON = 1,   /* the button on the glasses */
    HI_SRC_HEAD = 2,     /* IMU gesture */
    HI_SRC_NAV = 3,      /* Host-cooked HOGP navigation button */
    HI_SRC_RING = 4      /* raw HOGP event via Input extension */
};

#define HI_ACTION_NONE 0U

typedef struct {
    hi_input_t input;
    hi_source_t source;
    uint8_t repeat;        /* 1 when produced by a held key repeating */
    uint32_t timestamp_ms;
} hi_event_t;

/* Called once per mapped input. action is never HI_ACTION_NONE. */
typedef void (*hi_emit_fn)(void *context, uint8_t action, const hi_event_t *event);

/* Raw-mode options (hi_set_raw). */
#define HI_RAW_OFF 0U    /* Host cooked buttons only: what the inputmap delivers (default) */
#define HI_RAW_AUTO 1U   /* also claim undocumented Input extension 4 when present */

#define HI_WHEEL_STEP_DEFAULT 1      /* wheel units per emitted notch */
#define HI_GESTURE_GAP_MS 350U       /* drop duplicate gesture edges inside this */

typedef struct {
    const gm_plugin_host_api_t *host;
    const gm_plugin_input_extension_api_t *ext;
    hi_emit_fn emit;
    void *context;
    uint8_t keymap[HI_IN_COUNT];
    uint8_t repeatable[HI_IN_COUNT]; /* 1 = held key repeats the action */
    uint32_t guard_until_ms;         /* gestures before this time are ignored */
    uint32_t last_gesture_ms;
    hi_input_t last_gesture;
    uint8_t guard_active;
    uint8_t raw_mode;
    uint8_t raw_active;              /* subscription currently held */
    uint8_t running;
    hi_source_t last_source;
    int32_t wheel_accum;
    int32_t wheel_step;
    uint32_t counts[5];              /* inputs seen per hi_source_t */
} hi_state_t;

/* Initialise. host may be NULL in unit tests that only call hi_feed(). */
void hi_init(hi_state_t *state, const gm_plugin_host_api_t *host,
             hi_emit_fn emit, void *context);

/* Map one input to an app action (HI_ACTION_NONE unmaps it). */
void hi_map(hi_state_t *state, hi_input_t input, uint8_t action);
uint8_t hi_mapped(const hi_state_t *state, hi_input_t input);

/* Choose whether a held key/wheel repeats (navigation defaults to yes). */
void hi_set_repeatable(hi_state_t *state, hi_input_t input, uint8_t repeatable);

/* HI_RAW_OFF or HI_RAW_AUTO. Takes effect on the next hi_start(). */
void hi_set_raw(hi_state_t *state, uint8_t mode);

/* Wheel units per notch (>= 1). Rings with high-resolution wheels need more. */
void hi_set_wheel_step(hi_state_t *state, int32_t units);

/* Ignore head gestures until now + ms (e.g. right after a new card appears). */
void hi_guard_gestures(hi_state_t *state, uint32_t now_ms, uint32_t ms);

/* Lifecycle. hi_start subscribes raw HOGP input when enabled and available. */
void hi_start(hi_state_t *state);
void hi_stop(hi_state_t *state);

/* Feed a core Host event. Returns true when it was an input event. */
bool hi_on_event(hi_state_t *state, const gm_plugin_event_t *event);

/* Feed a raw Input extension event (normally called from the subscription). */
void hi_on_raw(hi_state_t *state, const gm_plugin_input_event_t *event);

/* Inject a normalized input directly (tests, phone-forwarded input). */
void hi_feed(hi_state_t *state, hi_input_t input, hi_source_t source,
             uint8_t repeat, uint32_t timestamp_ms);

/* Raw subscription is live (a ring's raw events reach this plugin). */
static inline bool hi_raw_active(const hi_state_t *state)
{
    return state->raw_active != 0U;
}

/* Short stable name for logs and hint text ("nod", "page_down"...). */
const char *hi_input_name(hi_input_t input);

#ifdef __cplusplus
}
#endif

#endif
