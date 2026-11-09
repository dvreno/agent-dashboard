#include "hud_input.h"

static const char *const s_names[HI_IN_COUNT] = {
    "none", "click", "double_click", "nod", "shake", "head_left", "head_right",
    "head_raise", "head_lower", "up", "down", "left", "right", "page_up",
    "page_down", "select", "back", "home", "menu", "play_pause", "next",
    "prev", "volume_up", "volume_down", "wheel_up", "wheel_down", "swipe_up",
    "swipe_down", "swipe_left", "swipe_right", "tap", "double_tap",
    "mouse_left", "mouse_right", "mouse_middle", "pad_a", "pad_b", "pad_x",
    "pad_y", "pad_l1", "pad_r1", "ai"
};

const char *hi_input_name(hi_input_t input)
{
    return input < HI_IN_COUNT ? s_names[input] : "unknown";
}

void hi_init(hi_state_t *state, const gm_plugin_host_api_t *host,
             hi_emit_fn emit, void *context)
{
    uint32_t i;
    uint8_t *bytes = (uint8_t *)state;
    for (i = 0; i < sizeof(*state); ++i) bytes[i] = 0;
    state->host = host;
    state->emit = emit;
    state->context = context;
    state->raw_mode = HI_RAW_AUTO;
    state->wheel_step = HI_WHEEL_STEP_DEFAULT;
    if (host != 0) (void)gm_plugin_input_get(host, &state->ext);
    /* Navigation-style inputs repeat while held; everything else fires once. */
    state->repeatable[HI_IN_NAV_UP] = 1U;
    state->repeatable[HI_IN_NAV_DOWN] = 1U;
    state->repeatable[HI_IN_NAV_LEFT] = 1U;
    state->repeatable[HI_IN_NAV_RIGHT] = 1U;
    state->repeatable[HI_IN_NAV_PAGE_UP] = 1U;
    state->repeatable[HI_IN_NAV_PAGE_DOWN] = 1U;
    state->repeatable[HI_IN_WHEEL_UP] = 1U;
    state->repeatable[HI_IN_WHEEL_DOWN] = 1U;
}

void hi_map(hi_state_t *state, hi_input_t input, uint8_t action)
{
    if (input > HI_IN_NONE && input < HI_IN_COUNT) state->keymap[input] = action;
}

uint8_t hi_mapped(const hi_state_t *state, hi_input_t input)
{
    return input < HI_IN_COUNT ? state->keymap[input] : (uint8_t)HI_ACTION_NONE;
}

void hi_set_repeatable(hi_state_t *state, hi_input_t input, uint8_t repeatable)
{
    if (input > HI_IN_NONE && input < HI_IN_COUNT)
        state->repeatable[input] = repeatable != 0U ? 1U : 0U;
}

void hi_set_raw(hi_state_t *state, uint8_t mode)
{
    state->raw_mode = mode == HI_RAW_OFF ? HI_RAW_OFF : HI_RAW_AUTO;
}

void hi_set_wheel_step(hi_state_t *state, int32_t units)
{
    state->wheel_step = units < 1 ? 1 : units;
    state->wheel_accum = 0;
}

void hi_guard_gestures(hi_state_t *state, uint32_t now_ms, uint32_t ms)
{
    state->guard_until_ms = now_ms + ms;
    state->guard_active = 1U;
}

static bool is_gesture(hi_input_t input)
{
    return input >= HI_IN_HEAD_NOD && input <= HI_IN_HEAD_LOWER;
}

void hi_feed(hi_state_t *state, hi_input_t input, hi_source_t source,
             uint8_t repeat, uint32_t timestamp_ms)
{
    hi_event_t event;
    uint8_t action;
    if (input == HI_IN_NONE || input >= HI_IN_COUNT) return;
    if (repeat != 0U && state->repeatable[input] == 0U) return;
    if (is_gesture(input)) {
        /* Wrapping-safe "now < guard_until". */
        if (state->guard_active != 0U) {
            if ((int32_t)(timestamp_ms - state->guard_until_ms) < 0) return;
            state->guard_active = 0U;
        }
        /* Some firmware reports one physical nod as two edges. */
        if (input == state->last_gesture &&
            timestamp_ms - state->last_gesture_ms < HI_GESTURE_GAP_MS) return;
        state->last_gesture = input;
        state->last_gesture_ms = timestamp_ms;
    }
    if (source < 5U) state->counts[source]++;
    state->last_source = source;
    action = state->keymap[input];
    if (action == HI_ACTION_NONE || state->emit == 0) return;
    event.input = input;
    event.source = source;
    event.repeat = repeat != 0U ? 1U : 0U;
    event.timestamp_ms = timestamp_ms;
    state->emit(state->context, action, &event);
}

static hi_input_t from_button(gm_plugin_button_t button,
                              gm_plugin_button_action_t action)
{
    if (button == GM_PLUGIN_BUTTON_PRIMARY) {
        if (action == GM_PLUGIN_BUTTON_ACTION_SINGLE) return HI_IN_BUTTON_SINGLE;
        if (action == GM_PLUGIN_BUTTON_ACTION_DOUBLE) return HI_IN_BUTTON_DOUBLE;
        /* LONG / VERY_LONG belong to the Host (exit); RELEASE carries nothing. */
        return HI_IN_NONE;
    }
    if (action != GM_PLUGIN_BUTTON_ACTION_TRIGGER) return HI_IN_NONE;
    switch (button) {
    case GM_PLUGIN_BUTTON_UP: return HI_IN_NAV_UP;
    case GM_PLUGIN_BUTTON_DOWN: return HI_IN_NAV_DOWN;
    case GM_PLUGIN_BUTTON_LEFT: return HI_IN_NAV_LEFT;
    case GM_PLUGIN_BUTTON_RIGHT: return HI_IN_NAV_RIGHT;
    case GM_PLUGIN_BUTTON_PAGE_UP: return HI_IN_NAV_PAGE_UP;
    case GM_PLUGIN_BUTTON_PAGE_DOWN: return HI_IN_NAV_PAGE_DOWN;
    case GM_PLUGIN_BUTTON_SCROLL_UP: return HI_IN_WHEEL_UP;
    case GM_PLUGIN_BUTTON_SCROLL_DOWN: return HI_IN_WHEEL_DOWN;
    case GM_PLUGIN_BUTTON_BACK: return HI_IN_NAV_BACK;
    case GM_PLUGIN_BUTTON_HOME: return HI_IN_NAV_HOME;
    default: return HI_IN_NONE;
    }
}

static hi_input_t from_gesture(gm_plugin_imu_gesture_t gesture)
{
    switch (gesture) {
    case GM_PLUGIN_IMU_GESTURE_NOD: return HI_IN_HEAD_NOD;
    case GM_PLUGIN_IMU_GESTURE_SHAKE: return HI_IN_HEAD_SHAKE;
    case GM_PLUGIN_IMU_GESTURE_LEFT: return HI_IN_HEAD_LEFT;
    case GM_PLUGIN_IMU_GESTURE_RIGHT: return HI_IN_HEAD_RIGHT;
    case GM_PLUGIN_IMU_GESTURE_HEAD_RAISE: return HI_IN_HEAD_RAISE;
    case GM_PLUGIN_IMU_GESTURE_HEAD_LOWER: return HI_IN_HEAD_LOWER;
    default: return HI_IN_NONE; /* raise/lower timeouts are not commands */
    }
}

bool hi_on_event(hi_state_t *state, const gm_plugin_event_t *event)
{
    hi_input_t input;
    if (event == 0) return false;
    if (event->type == GM_PLUGIN_EVENT_BUTTON) {
        gm_plugin_button_t button = event->data.button.button;
        input = from_button(button, event->data.button.action);
        hi_feed(state, input,
                button == GM_PLUGIN_BUTTON_PRIMARY ? HI_SRC_BUTTON : HI_SRC_NAV,
                0U, event->timestamp_ms);
        return true;
    }
    if (event->type == GM_PLUGIN_EVENT_IMU_GESTURE) {
        if (event->data.imu_gesture.active)
            hi_feed(state, from_gesture(event->data.imu_gesture.gesture),
                    HI_SRC_HEAD, 0U, event->timestamp_ms);
        return true;
    }
    return false;
}

static hi_input_t from_key(gm_plugin_input_key_t key)
{
    switch (key) {
    case GM_PLUGIN_INPUT_KEY_UP: return HI_IN_NAV_UP;
    case GM_PLUGIN_INPUT_KEY_DOWN: return HI_IN_NAV_DOWN;
    case GM_PLUGIN_INPUT_KEY_LEFT: return HI_IN_NAV_LEFT;
    case GM_PLUGIN_INPUT_KEY_RIGHT: return HI_IN_NAV_RIGHT;
    case GM_PLUGIN_INPUT_KEY_SELECT: return HI_IN_NAV_SELECT;
    case GM_PLUGIN_INPUT_KEY_BACK: return HI_IN_NAV_BACK;
    case GM_PLUGIN_INPUT_KEY_HOME: return HI_IN_NAV_HOME;
    case GM_PLUGIN_INPUT_KEY_MENU: return HI_IN_NAV_MENU;
    case GM_PLUGIN_INPUT_KEY_NEXT: return HI_IN_MEDIA_NEXT;
    case GM_PLUGIN_INPUT_KEY_PREV: return HI_IN_MEDIA_PREV;
    case GM_PLUGIN_INPUT_KEY_PLAY_PAUSE: return HI_IN_MEDIA_PLAY_PAUSE;
    case GM_PLUGIN_INPUT_KEY_VOL_UP: return HI_IN_VOLUME_UP;
    case GM_PLUGIN_INPUT_KEY_VOL_DOWN: return HI_IN_VOLUME_DOWN;
    case GM_PLUGIN_INPUT_KEY_PAGE_UP: return HI_IN_NAV_PAGE_UP;
    case GM_PLUGIN_INPUT_KEY_PAGE_DOWN: return HI_IN_NAV_PAGE_DOWN;
    case GM_PLUGIN_INPUT_KEY_SCROLL_UP: return HI_IN_WHEEL_UP;
    case GM_PLUGIN_INPUT_KEY_SCROLL_DOWN: return HI_IN_WHEEL_DOWN;
    case GM_PLUGIN_INPUT_KEY_DOUBLE: return HI_IN_BUTTON_DOUBLE;
    case GM_PLUGIN_INPUT_KEY_MOUSE_LEFT: return HI_IN_MOUSE_LEFT;
    case GM_PLUGIN_INPUT_KEY_MOUSE_RIGHT: return HI_IN_MOUSE_RIGHT;
    case GM_PLUGIN_INPUT_KEY_MOUSE_MIDDLE: return HI_IN_MOUSE_MIDDLE;
    case GM_PLUGIN_INPUT_KEY_GAMEPAD_A: return HI_IN_GAMEPAD_A;
    case GM_PLUGIN_INPUT_KEY_GAMEPAD_B: return HI_IN_GAMEPAD_B;
    case GM_PLUGIN_INPUT_KEY_GAMEPAD_X: return HI_IN_GAMEPAD_X;
    case GM_PLUGIN_INPUT_KEY_GAMEPAD_Y: return HI_IN_GAMEPAD_Y;
    case GM_PLUGIN_INPUT_KEY_GAMEPAD_L1: return HI_IN_GAMEPAD_L1;
    case GM_PLUGIN_INPUT_KEY_GAMEPAD_R1: return HI_IN_GAMEPAD_R1;
    case GM_PLUGIN_INPUT_KEY_AI_TRIGGER: return HI_IN_AI_TRIGGER;
    /* KEY_LONG is the Host exit gesture; never claim it. */
    default: return HI_IN_NONE;
    }
}

static hi_input_t from_touch(gm_plugin_input_key_t key)
{
    switch (key) {
    case GM_PLUGIN_INPUT_KEY_TOUCH_TAP: return HI_IN_TAP;
    case GM_PLUGIN_INPUT_KEY_TOUCH_DOUBLE_TAP: return HI_IN_DOUBLE_TAP;
    case GM_PLUGIN_INPUT_KEY_TOUCH_SWIPE_UP: return HI_IN_SWIPE_UP;
    case GM_PLUGIN_INPUT_KEY_TOUCH_SWIPE_DOWN: return HI_IN_SWIPE_DOWN;
    case GM_PLUGIN_INPUT_KEY_TOUCH_SWIPE_LEFT: return HI_IN_SWIPE_LEFT;
    case GM_PLUGIN_INPUT_KEY_TOUCH_SWIPE_RIGHT: return HI_IN_SWIPE_RIGHT;
    default: return HI_IN_NONE; /* down/move/up/pressure: not discrete commands */
    }
}

void hi_on_raw(hi_state_t *state, const gm_plugin_input_event_t *event)
{
    gm_plugin_input_classes_t category;
    if (event == 0 || event->struct_size < sizeof(*event)) return;
    category = gm_plugin_input_event_class(event);
    if (category == GM_PLUGIN_INPUT_CLASS_KEY) {
        hi_input_t input = from_key(event->key);
        if (event->phase == GM_PLUGIN_INPUT_PHASE_DOWN)
            hi_feed(state, input, HI_SRC_RING, 0U, event->timestamp_ms);
        else if (event->phase == GM_PLUGIN_INPUT_PHASE_REPEAT)
            hi_feed(state, input, HI_SRC_RING, 1U, event->timestamp_ms);
        return;
    }
    if (category == GM_PLUGIN_INPUT_CLASS_REL) {
        int32_t step = state->wheel_step;
        if (event->key != GM_PLUGIN_INPUT_KEY_REL_WHEEL) return; /* pointer motion */
        /* Wheel positive means scroll up. Emit one notch per wheel_step units. */
        state->wheel_accum += event->value;
        while (state->wheel_accum >= step) {
            state->wheel_accum -= step;
            hi_feed(state, HI_IN_WHEEL_UP, HI_SRC_RING, 0U, event->timestamp_ms);
        }
        while (state->wheel_accum <= -step) {
            state->wheel_accum += step;
            hi_feed(state, HI_IN_WHEEL_DOWN, HI_SRC_RING, 0U, event->timestamp_ms);
        }
        return;
    }
    if (category == GM_PLUGIN_INPUT_CLASS_TOUCH) {
        if (event->phase == GM_PLUGIN_INPUT_PHASE_DOWN ||
            event->phase == GM_PLUGIN_INPUT_PHASE_MOVE)
            hi_feed(state, from_touch(event->key), HI_SRC_RING, 0U,
                    event->timestamp_ms);
        return;
    }
    /* ABS (joysticks, digitizer axes) is not mapped to commands. */
}

static void raw_callback(void *context, const gm_plugin_input_event_t *event)
{
    hi_state_t *state = context;
    if (state == 0 || state->raw_active == 0U) return;
    hi_on_raw(state, event);
}

void hi_start(hi_state_t *state)
{
    state->running = 1U;
    state->wheel_accum = 0;
    state->raw_active = 0U;
    if (state->raw_mode == HI_RAW_OFF || state->ext == 0) return;
    /* KEY|REL|TOUCH: claiming these replaces the Host's cooked navigation for
     * HOGP devices, so every key we care about must be mapped in from_key(). */
    if (state->ext->subscribe(GM_PLUGIN_INPUT_CLASS_KEY | GM_PLUGIN_INPUT_CLASS_REL |
                              GM_PLUGIN_INPUT_CLASS_TOUCH,
                              raw_callback, state) == GM_PLUGIN_OK)
        state->raw_active = 1U;
}

void hi_stop(hi_state_t *state)
{
    state->running = 0U;
    if (state->ext != 0 && state->raw_active != 0U) state->ext->unsubscribe();
    state->raw_active = 0U;
    state->wheel_accum = 0;
}
