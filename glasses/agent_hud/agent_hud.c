/*
 * Agent Dashboard for MemoMind glasses: a paged reader for Claude Code.
 *
 * The phone plugin relays Claude Code activity (phone/native-link.js). This
 * plugin keeps the scroll-back on the glasses, so paging is instant and costs
 * no Bluetooth: the phone only sends new text once. Approvals are answered
 * here with a nod or a shake and sent back to the phone.
 *
 * Screen (600 x 350):
 *   header   state icon, "Claude · project · working", clock / sessions
 *   waiting  what the agent is waiting for (hidden when nothing)
 *   body     wrapped history lines with kind icons, scroll bar
 *   footer   LIVE / "37 back · 5 new", hints, toast
 *   card     approval / question card over the body
 */
#include "agent_proto.h"
#include "history.h"
#include "hud_input/hud_input.h"
#include "hud_render/hud_render.h"

#include "gm_plugin_system_events.h"

/* ---- layout ---------------------------------------------------------------- */

#define SCREEN_W 600
#define MARGIN 12
#define HEADER_Y 4
#define WAIT_Y 30
#define WAIT_H 26
#define BODY_TOP 62
#define BODY_BOTTOM 320
#define FOOTER_Y 326
#define ICON_SIZE 16
#define TEXT_X (MARGIN + ICON_SIZE + 8)
#define TEXT_W (SCREEN_W - TEXT_X - MARGIN - 8)
#define SCROLL_X (SCREEN_W - MARGIN)
#define MAX_ROWS 16
#define CARD_ROWS 8

/* ---- behaviour ------------------------------------------------------------- */

#define MAX_ASKS 4
#define ASK_TITLE_BYTES 96
#define ASK_PROJECT_BYTES 64
#define ASK_DETAIL_BYTES 1024
#define SETTLE_MS 800U           /* ignore gestures right after a card appears */
#define CONFIRM_MS 5000U         /* high risk: press the button within this */
#define ANSWER_TIMEOUT_MS 6000U  /* no ACK from the phone */
#define TOAST_MS 1600U
#define HELLO_RETRY_MS 3000U
#define FRAME_MS 50U             /* coalesce redraws */

/* App actions (hud_input keymap values). */
enum {
    A_NONE = 0,
    A_LINE_UP = 1,      /* one line older */
    A_LINE_DOWN = 2,    /* one line newer */
    A_PAGE_UP = 3,
    A_PAGE_DOWN = 4,
    A_SELECT = 5,       /* confirm / page back when reading */
    A_NEXT = 6,         /* next card, or back to live */
    A_BACK = 7,         /* hide card to read history, or go live */
    A_LIVE = 8,
    A_YES = 9,          /* nod */
    A_NO = 10,          /* shake */
    A_TOP = 11          /* oldest line */
};

typedef struct {
    uint32_t id;
    uint32_t received_ms;
    uint16_t seconds;
    uint8_t risk;
    uint8_t kind;
    uint8_t used;
    char title[ASK_TITLE_BYTES];
    char project[ASK_PROJECT_BYTES];
    char detail[ASK_DETAIL_BYTES];
} ask_t;

typedef struct {
    gm_plugin_lvgl_obj_t *icon;
    hr_cell_t text;
    uint8_t icon_slot;          /* 0xFF = none shown */
} row_t;

typedef struct {
    const gm_plugin_host_api_t *host;
    hr_ctx_t r;
    hi_state_t in;
    hist_t hist;
    hr_assets_t assets;
    const gm_plugin_system_events_extension_api_t *sys;

    gm_plugin_lvgl_obj_t *root;
    gm_plugin_lvgl_obj_t *state_icon;
    uint8_t state_icon_slot;
    hr_cell_t head_left, head_right;
    gm_plugin_lvgl_obj_t *wait_box;
    hr_cell_t wait_text;
    row_t rows[MAX_ROWS];
    gm_plugin_lvgl_obj_t *track, *thumb;
    hr_cell_t foot_left, foot_right, toast;
    gm_plugin_lvgl_obj_t *card;
    hr_cell_t card_title, card_meta, card_hint, card_count;
    hr_cell_t card_rows[CARD_ROWS];

    /* state from the phone */
    uint8_t state;
    uint8_t sessions;
    char head_left_text[96];
    char head_right_text[48];
    char waiting[256];
    ask_t asks[MAX_ASKS];
    uint32_t focus_id;
    uint32_t focus_ms;          /* when the focused card appeared */
    uint32_t armed_until;
    uint8_t armed;
    uint32_t sending_id;
    uint32_t sending_ms;
    uint8_t card_hidden;        /* user went back to read history */
    uint16_t card_scroll;       /* first detail line shown */

    /* reader */
    uint32_t top;               /* absolute number of first visible line */
    uint8_t follow;             /* stick to the newest line */
    uint32_t unread;
    int16_t line_h;
    uint8_t visible_rows;
    uint8_t head_paging;        /* head left/right pages the history */

    /* misc */
    char toast_text[64];
    uint32_t toast_until;
    uint32_t hello_ms;
    uint8_t phone_seen;         /* got any message from the phone */
    uint8_t connected;
    uint8_t started;
    uint8_t dirty;
    uint8_t call_ui;
    uint32_t since_frame;
    uint32_t last_second;
    char line_buf[256];
    char fmt[160];
} app_t;

/* The state lives on the Host heap, not in .bss: with a large static struct
 * GCC addresses fields as "s_app + 0x2000 - n", which the XIP packer rejects
 * as a relocation outside the image. Allocated in on_load. */
static app_t *g_app;
static const gm_plugin_host_api_t *g_host;
#define s_app (*g_app)

/* ---- small helpers --------------------------------------------------------- */

static uint32_t now(void)
{
    return s_app.host->monotonic_ms();
}

static void copy_str(char *dst, uint32_t cap, const uint8_t *src, uint32_t len)
{
    uint32_t i;
    if (cap == 0U) return;
    if (len >= cap) {
        len = cap - 1U;
        /* Do not cut a UTF-8 sequence in half. */
        while (len > 0U && (src[len] & 0xC0U) == 0x80U) len--;
    }
    for (i = 0; i < len; ++i) dst[i] = (char)src[i];
    dst[len] = '\0';
}

/* Bounded reader over a message body. */
typedef struct {
    const uint8_t *p;
    uint32_t left;
    uint8_t ok;
} rd_t;

static uint8_t rd_u8(rd_t *r)
{
    if (r->left < 1U) { r->ok = 0U; return 0U; }
    r->left--;
    return *r->p++;
}

static uint16_t rd_u16(rd_t *r)
{
    uint16_t v;
    if (r->left < 2U) { r->ok = 0U; r->left = 0U; return 0U; }
    v = hr_u16(r->p);
    r->p += 2;
    r->left -= 2U;
    return v;
}

static uint32_t rd_u32(rd_t *r)
{
    uint32_t v;
    if (r->left < 4U) { r->ok = 0U; r->left = 0U; return 0U; }
    v = hr_u32(r->p);
    r->p += 4;
    r->left -= 4U;
    return v;
}

static const uint8_t *rd_bytes(rd_t *r, uint32_t n)
{
    const uint8_t *p = r->p;
    if (r->left < n) { r->ok = 0U; r->left = 0U; return 0; }
    r->p += n;
    r->left -= n;
    return p;
}

static void rd_str8(rd_t *r, char *dst, uint32_t cap)
{
    uint8_t n = rd_u8(r);
    const uint8_t *p = rd_bytes(r, n);
    if (p != 0) copy_str(dst, cap, p, n);
    else dst[0] = '\0';
}

static void rd_str16(rd_t *r, char *dst, uint32_t cap)
{
    uint16_t n = rd_u16(r);
    const uint8_t *p = rd_bytes(r, n);
    if (p != 0) copy_str(dst, cap, p, n);
    else dst[0] = '\0';
}

static void send(const uint8_t *data, uint32_t len)
{
    if (s_app.host->bt_send != 0)
        (void)s_app.host->bt_send(AGENT_CH_UP, data, len);
}

static void toast(const char *text)
{
    uint32_t n = (uint32_t)s_app.r.libc->strlen(text);
    copy_str(s_app.toast_text, sizeof(s_app.toast_text), (const uint8_t *)text, n);
    s_app.toast_until = now() + TOAST_MS;
    s_app.dirty = 1U;
}

/* ---- phone messages out ------------------------------------------------------ */

static void send_hello(void)
{
    uint8_t msg[12 + 1 + ICON_COUNT * 4];
    uint32_t i, n = 0;
    uint8_t flags = 0;
    if (hi_raw_active(&s_app.in)) flags |= HELLO_RAW_INPUT;
    if (s_app.r.lz4 != 0) flags |= HELLO_LZ4;
    msg[n++] = EVT_HELLO;
    msg[n++] = AGENT_PROTO_VERSION;
    hr_put_u16(msg + n, SCREEN_W); n += 2;
    hr_put_u16(msg + n, 350); n += 2;
    msg[n++] = flags;
    hr_put_u32(msg + n, s_app.hist.last_seq); n += 4;
    msg[n++] = ICON_COUNT;
    for (i = 0; i < ICON_COUNT; ++i) {
        hr_put_u32(msg + n, hr_asset_hash(&s_app.assets, (uint8_t)i));
        n += 4;
    }
    send(msg, n);
    s_app.hello_ms = now();
}

static void send_need(uint32_t from_seq)
{
    uint8_t msg[5];
    msg[0] = EVT_NEED;
    hr_put_u32(msg + 1, from_seq);
    send(msg, sizeof(msg));
}

static void send_answer(uint32_t id, uint8_t decision, uint8_t via)
{
    uint8_t msg[7];
    msg[0] = EVT_ANSWER;
    hr_put_u32(msg + 1, id);
    msg[5] = decision;
    msg[6] = via;
    send(msg, sizeof(msg));
}

static void send_view(void)
{
    uint8_t msg[14];
    uint8_t mode = VIEW_LIVE;
    msg[0] = EVT_VIEW;
    if (s_app.focus_id != 0U && s_app.card_hidden == 0U) mode = VIEW_CARD;
    else if (s_app.follow == 0U) mode = VIEW_HISTORY;
    msg[1] = mode;
    hr_put_u32(msg + 2, s_app.top);
    hr_put_u32(msg + 6, hist_end(&s_app.hist));
    hr_put_u32(msg + 10, s_app.unread);
    send(msg, sizeof(msg));
}

/* ---- reader position --------------------------------------------------------- */

static uint32_t max_top(void)
{
    uint32_t end = hist_end(&s_app.hist);
    uint32_t first = s_app.hist.first;
    if (end - first <= s_app.visible_rows) return first;
    return end - s_app.visible_rows;
}

static void clamp_top(void)
{
    uint32_t hi = max_top();
    if (s_app.top < s_app.hist.first) s_app.top = s_app.hist.first;
    if (s_app.top > hi) s_app.top = hi;
}

static void go_live(void)
{
    s_app.follow = 1U;
    s_app.unread = 0U;
    s_app.top = max_top();
    s_app.dirty = 1U;
}

static void scroll_by(int32_t lines)
{
    uint32_t hi = max_top();
    if (lines < 0) {
        uint32_t back = (uint32_t)(-lines);
        s_app.top = s_app.top - s_app.hist.first > back ? s_app.top - back : s_app.hist.first;
        s_app.follow = 0U;
    } else if (lines > 0) {
        s_app.top += (uint32_t)lines;
        if (s_app.top >= hi) {
            go_live();
            return;
        }
    }
    clamp_top();
    if (s_app.top >= hi && s_app.follow == 0U && lines > 0) go_live();
    s_app.dirty = 1U;
}

/* ---- asks ---------------------------------------------------------------------- */

static ask_t *find_ask(uint32_t id)
{
    uint32_t i;
    for (i = 0; i < MAX_ASKS; ++i)
        if (s_app.asks[i].used != 0U && s_app.asks[i].id == id) return &s_app.asks[i];
    return 0;
}

static ask_t *focused(void)
{
    return s_app.focus_id != 0U ? find_ask(s_app.focus_id) : 0;
}

static void set_focus(uint32_t id)
{
    if (id == s_app.focus_id) return;
    s_app.focus_id = id;
    s_app.focus_ms = now();
    s_app.armed = 0U;
    s_app.card_scroll = 0U;
    s_app.card_hidden = 0U;
    hi_guard_gestures(&s_app.in, s_app.focus_ms, SETTLE_MS);
    s_app.dirty = 1U;
}

static void refocus(void)
{
    uint32_t i, oldest = 0U, best_ms = 0U;
    if (focused() != 0) return;
    for (i = 0; i < MAX_ASKS; ++i) {
        ask_t *a = &s_app.asks[i];
        if (a->used == 0U) continue;
        if (oldest == 0U || (int32_t)(a->received_ms - best_ms) < 0) {
            oldest = a->id;
            best_ms = a->received_ms;
        }
    }
    s_app.focus_id = 0U;
    if (oldest != 0U) set_focus(oldest);
    else s_app.dirty = 1U;
}

static void drop_ask(uint32_t id)
{
    uint32_t i;
    for (i = 0; i < MAX_ASKS; ++i) {
        if (s_app.asks[i].used != 0U && (id == 0U || s_app.asks[i].id == id))
            s_app.asks[i].used = 0U;
    }
    if (id == 0U || s_app.sending_id == id) s_app.sending_id = 0U;
    if (id == 0U || s_app.focus_id == id) {
        s_app.focus_id = 0U;
        s_app.armed = 0U;
    }
    refocus();
    s_app.dirty = 1U;
}

static uint32_t seconds_left(const ask_t *a)
{
    uint32_t elapsed = (now() - a->received_ms) / 1000U;
    return elapsed >= a->seconds ? 0U : a->seconds - elapsed;
}

static void answer(uint8_t decision, uint8_t via)
{
    ask_t *a = focused();
    if (a == 0 || s_app.sending_id == a->id) return;
    send_answer(a->id, decision, via);
    if (decision == DECISION_TALK) {
        toast("Talk: phone mic");
        return;
    }
    s_app.sending_id = a->id;
    s_app.sending_ms = now();
    s_app.armed = 0U;
    s_app.dirty = 1U;
}

static void next_card(void)
{
    uint32_t i, start = 0U;
    for (i = 0; i < MAX_ASKS; ++i)
        if (s_app.asks[i].used != 0U && s_app.asks[i].id == s_app.focus_id) start = i;
    for (i = 1; i <= MAX_ASKS; ++i) {
        ask_t *a = &s_app.asks[(start + i) % MAX_ASKS];
        if (a->used != 0U && a->id != s_app.focus_id) {
            set_focus(a->id);
            return;
        }
    }
}

/* ---- input --------------------------------------------------------------------- */

static uint8_t via_for(const hi_event_t *ev)
{
    if (ev->source == HI_SRC_HEAD) return ev->input == HI_IN_HEAD_SHAKE ? VIA_SHAKE : VIA_NOD;
    if (ev->source == HI_SRC_RING || ev->source == HI_SRC_NAV) return VIA_RING;
    return VIA_BUTTON;
}

static void card_scroll(int32_t delta)
{
    int32_t next = (int32_t)s_app.card_scroll + delta;
    s_app.card_scroll = (uint16_t)(next < 0 ? 0 : next > 200 ? 200 : next);
    s_app.dirty = 1U;
}

static void on_action(void *context, uint8_t action, const hi_event_t *ev)
{
    ask_t *a = focused();
    bool card = a != 0 && s_app.card_hidden == 0U;
    uint32_t t = ev->timestamp_ms != 0U ? ev->timestamp_ms : now();
    uint8_t msg[4];
    int32_t page = s_app.visible_rows > 2U ? (int32_t)s_app.visible_rows - 1 : 1;
    (void)context;

    msg[0] = EVT_INPUT;
    msg[1] = ev->input;
    msg[2] = ev->source;
    msg[3] = action;
    send(msg, sizeof(msg));

    /* Head left/right is optional paging: off means ignore. */
    if (s_app.head_paging == 0U &&
        (ev->input == HI_IN_HEAD_LEFT || ev->input == HI_IN_HEAD_RIGHT)) return;

    if (card) {
        bool settled = t - s_app.focus_ms >= SETTLE_MS;
        if (s_app.armed != 0U && (int32_t)(t - s_app.armed_until) > 0) s_app.armed = 0U;
        switch (action) {
        case A_YES:
            if (!settled) return;
            if (a->kind == ASK_LISTEN) return;    /* talking needs the button */
            if (a->risk == RISK_HIGH) {
                s_app.armed = 1U;
                s_app.armed_until = t + CONFIRM_MS;
                s_app.dirty = 1U;
            } else {
                answer(DECISION_ALLOW, via_for(ev));
            }
            return;
        case A_NO:
            if (!settled) return;
            s_app.armed = 0U;
            answer(DECISION_DENY, via_for(ev));
            return;
        case A_SELECT:
            if (a->kind == ASK_LISTEN) {
                answer(DECISION_TALK, via_for(ev));
            } else if (s_app.armed != 0U) {
                answer(DECISION_ALLOW, VIA_BUTTON);  /* never approves on its own */
            }
            return;
        case A_NEXT: next_card(); return;
        case A_BACK:
            s_app.card_hidden = 1U;
            s_app.armed = 0U;
            s_app.dirty = 1U;
            return;
        case A_LINE_UP: card_scroll(-1); return;
        case A_LINE_DOWN: card_scroll(1); return;
        case A_PAGE_UP: card_scroll(-(CARD_ROWS - 1)); return;
        case A_PAGE_DOWN: card_scroll(CARD_ROWS - 1); return;
        default: return;
        }
    }

    switch (action) {
    case A_LINE_UP: scroll_by(-1); break;
    case A_LINE_DOWN: scroll_by(1); break;
    case A_PAGE_UP: scroll_by(-page); break;
    case A_PAGE_DOWN: scroll_by(page); break;
    case A_TOP: s_app.top = s_app.hist.first; s_app.follow = 0U; clamp_top(); s_app.dirty = 1U; break;
    case A_SELECT:
        if (a != 0) { s_app.card_hidden = 0U; s_app.dirty = 1U; }  /* back to the card */
        else scroll_by(-page);                                     /* button-only paging */
        break;
    case A_NEXT:
    case A_LIVE:
        if (a != 0 && action == A_NEXT) { s_app.card_hidden = 0U; s_app.dirty = 1U; }
        else go_live();
        break;
    case A_BACK:
        if (a != 0) { s_app.card_hidden = 0U; s_app.dirty = 1U; }
        else go_live();
        break;
    default: break;
    }
    send_view();
}

static void default_keymap(hi_state_t *in)
{
    hi_map(in, HI_IN_BUTTON_SINGLE, A_SELECT);
    hi_map(in, HI_IN_BUTTON_DOUBLE, A_NEXT);
    hi_map(in, HI_IN_HEAD_NOD, A_YES);
    hi_map(in, HI_IN_HEAD_SHAKE, A_NO);
    hi_map(in, HI_IN_HEAD_LEFT, A_PAGE_UP);
    hi_map(in, HI_IN_HEAD_RIGHT, A_PAGE_DOWN);
    hi_map(in, HI_IN_NAV_UP, A_LINE_UP);
    hi_map(in, HI_IN_NAV_DOWN, A_LINE_DOWN);
    hi_map(in, HI_IN_NAV_LEFT, A_PAGE_UP);
    hi_map(in, HI_IN_NAV_RIGHT, A_PAGE_DOWN);
    hi_map(in, HI_IN_NAV_PAGE_UP, A_PAGE_UP);
    hi_map(in, HI_IN_NAV_PAGE_DOWN, A_PAGE_DOWN);
    hi_map(in, HI_IN_NAV_SELECT, A_SELECT);
    hi_map(in, HI_IN_NAV_BACK, A_BACK);
    hi_map(in, HI_IN_NAV_HOME, A_LIVE);
    hi_map(in, HI_IN_NAV_MENU, A_NEXT);
    hi_map(in, HI_IN_MEDIA_PLAY_PAUSE, A_SELECT);
    hi_map(in, HI_IN_MEDIA_NEXT, A_PAGE_DOWN);
    hi_map(in, HI_IN_MEDIA_PREV, A_PAGE_UP);
    hi_map(in, HI_IN_VOLUME_UP, A_LINE_UP);
    hi_map(in, HI_IN_VOLUME_DOWN, A_LINE_DOWN);
    hi_map(in, HI_IN_WHEEL_UP, A_LINE_UP);
    hi_map(in, HI_IN_WHEEL_DOWN, A_LINE_DOWN);
    hi_map(in, HI_IN_SWIPE_UP, A_PAGE_DOWN);
    hi_map(in, HI_IN_SWIPE_DOWN, A_PAGE_UP);
    hi_map(in, HI_IN_SWIPE_LEFT, A_PAGE_UP);
    hi_map(in, HI_IN_SWIPE_RIGHT, A_PAGE_DOWN);
    hi_map(in, HI_IN_TAP, A_SELECT);
    hi_map(in, HI_IN_DOUBLE_TAP, A_NEXT);
    hi_map(in, HI_IN_MOUSE_LEFT, A_SELECT);
    hi_map(in, HI_IN_MOUSE_RIGHT, A_BACK);
    hi_map(in, HI_IN_MOUSE_MIDDLE, A_LIVE);
    hi_map(in, HI_IN_GAMEPAD_A, A_SELECT);
    hi_map(in, HI_IN_GAMEPAD_B, A_BACK);
    hi_map(in, HI_IN_GAMEPAD_X, A_NEXT);
    hi_map(in, HI_IN_GAMEPAD_L1, A_PAGE_UP);
    hi_map(in, HI_IN_GAMEPAD_R1, A_PAGE_DOWN);
}

/* ---- phone messages in ---------------------------------------------------------- */

static void on_entries(rd_t *r)
{
    uint32_t seq = rd_u32(r);
    uint8_t count = rd_u8(r);
    uint32_t i, before_end = hist_end(&s_app.hist);
    if (!r->ok) return;
    for (i = 0; i < count; ++i, ++seq) {
        uint8_t kind = rd_u8(r);
        uint16_t len;
        const uint8_t *text;
        (void)rd_u8(r); /* flags: reserved */
        len = rd_u16(r);
        text = rd_bytes(r, len);
        if (!r->ok) return;
        if (seq <= s_app.hist.last_seq) continue;            /* duplicate (resend) */
        if (seq != s_app.hist.last_seq + 1U && s_app.hist.last_seq != 0U) {
            send_need(s_app.hist.last_seq + 1U);              /* gap: ask again */
            return;
        }
        (void)hist_append(&s_app.hist, kind < KIND_COUNT ? kind : KIND_TEXT,
                          (const char *)text, len);
        s_app.hist.last_seq = seq;
    }
    if (s_app.follow != 0U) {
        s_app.top = max_top();
    } else {
        s_app.unread += hist_end(&s_app.hist) - before_end;
        clamp_top();
    }
    s_app.dirty = 1U;
}

static void on_status(rd_t *r)
{
    s_app.state = rd_u8(r);
    s_app.sessions = rd_u8(r);
    rd_str8(r, s_app.head_left_text, sizeof(s_app.head_left_text));
    rd_str8(r, s_app.head_right_text, sizeof(s_app.head_right_text));
    rd_str16(r, s_app.waiting, sizeof(s_app.waiting));
    s_app.dirty = 1U;
}

static void on_ask(rd_t *r)
{
    uint32_t id = rd_u32(r);
    ask_t *a;
    uint32_t i;
    if (!r->ok || id == 0U) return;
    a = find_ask(id);
    if (a == 0) {
        for (i = 0; i < MAX_ASKS && a == 0; ++i)
            if (s_app.asks[i].used == 0U) a = &s_app.asks[i];
        if (a == 0) return;  /* phone keeps the rest; they come when one clears */
        a->received_ms = now();
    }
    a->id = id;
    a->risk = rd_u8(r);
    a->kind = rd_u8(r);
    a->seconds = rd_u16(r);
    rd_str8(r, a->title, sizeof(a->title));
    rd_str8(r, a->project, sizeof(a->project));
    rd_str16(r, a->detail, sizeof(a->detail));
    if (!r->ok) return;
    a->received_ms = now();  /* seconds are relative to this message */
    a->used = 1U;
    refocus();
    s_app.dirty = 1U;
}

static void on_config(rd_t *r)
{
    uint8_t raw = rd_u8(r);
    uint8_t wheel = rd_u8(r);
    uint8_t head = rd_u8(r);
    uint8_t n = rd_u8(r);
    uint32_t i;
    if (!r->ok) return;
    hi_set_wheel_step(&s_app.in, wheel == 0U ? 1 : wheel);
    s_app.head_paging = head != 0U ? 1U : 0U;
    for (i = 0; i < n; ++i) {
        uint8_t input = rd_u8(r);
        uint8_t action = rd_u8(r);
        if (!r->ok) return;
        hi_map(&s_app.in, input, action);
    }
    if ((raw == HI_RAW_OFF) != (s_app.in.raw_mode == HI_RAW_OFF)) {
        hi_set_raw(&s_app.in, raw);
        if (s_app.started != 0U) {
            hi_stop(&s_app.in);
            hi_start(&s_app.in);
        }
        send_hello();
    }
}

static void on_asset(const uint8_t *body, uint32_t len, bool begin)
{
    uint8_t slot = 0xFFU;
    uint8_t msg[3];
    int result = begin ? hr_handle_asset_begin(&s_app.r, &s_app.assets, body, len, &slot)
                       : hr_handle_asset_tile(&s_app.r, &s_app.assets, body, len, &slot);
    if (result == HR_PARTIAL || (begin && result == HR_OK)) return;
    msg[0] = EVT_ASSET;
    msg[1] = slot;
    msg[2] = (uint8_t)(int8_t)result;
    send(msg, sizeof(msg));
    if (result == HR_COMPLETE) s_app.dirty = 1U;
}

static void on_message(const uint8_t *data, uint32_t len)
{
    rd_t r;
    uint8_t cmd;
    if (len == 0U) return;
    cmd = data[0];
    r.p = data + 1;
    r.left = len - 1U;
    r.ok = 1U;
    s_app.phone_seen = 1U;
    switch (cmd) {
    case CMD_HELLO_REQ: send_hello(); break;
    case CMD_ENTRIES: on_entries(&r); break;
    case CMD_STATUS: on_status(&r); break;
    case CMD_ASK: on_ask(&r); break;
    case CMD_ASK_CLEAR: drop_ask(rd_u32(&r)); break;
    case CMD_RESET:
        hist_reset(&s_app.hist);
        drop_ask(0U);
        go_live();
        break;
    case CMD_ASSET_BEGIN: on_asset(r.p, r.left, true); break;
    case CMD_ASSET_TILE: on_asset(r.p, r.left, false); break;
    case CMD_FB_TILE:
        /* Generic kit path; LVGL redraws over it, so only for overlay-free UIs. */
        (void)hr_handle_fb_tile(&s_app.r, r.p, r.left);
        break;
    case CMD_CONFIG: on_config(&r); break;
    case CMD_ANSWER_ACK: {
        uint32_t id = rd_u32(&r);
        uint8_t ok = rd_u8(&r);
        if (!r.ok) break;
        if (ok != 0U) {
            ask_t *a = find_ask(id);
            toast(a != 0 && s_app.sending_id == id ? "Sent" : "Answered");
            drop_ask(id);
        } else {
            if (s_app.sending_id == id) s_app.sending_id = 0U;
            toast("Answer failed - try again");
        }
        break;
    }
    case CMD_NOTICE: {
        char text[64];
        rd_str8(&r, text, sizeof(text));
        if (r.ok) toast(text);
        break;
    }
    default: break;
    }
}

/* ---- drawing ----------------------------------------------------------------------- */

static uint32_t wrap_line(void *context, const char *utf8)
{
    const gm_plugin_lvgl_api_t *ui = s_app.r.ui;
    gm_plugin_lvgl_coord_t used = 0;
    (void)context;
    return ui->text_get_next_line(utf8, ui->font_default, 0, TEXT_W, &used,
                                  GM_PLUGIN_LVGL_TEXT_FLAG_NONE);
}

static void set_icon(gm_plugin_lvgl_obj_t **icon, uint8_t *shown, gm_plugin_lvgl_obj_t *parent,
                     uint8_t slot, int16_t x, int16_t y)
{
    const gm_plugin_lvgl_image_dsc_t *dsc = slot < ICON_COUNT ? hr_asset_image(&s_app.assets, slot) : 0;
    if (dsc == 0) {
        if (*icon != 0 && *shown != 0xFFU) hr_show(&s_app.r, *icon, false);
        *shown = 0xFFU;
        return;
    }
    if (*icon == 0) {
        *icon = s_app.r.ui->image_create(parent, dsc);
        if (*icon == 0) return;
        s_app.r.ui->obj_set_pos(*icon, x, y);
        *shown = slot;
        return;
    }
    if (*shown != slot) {
        (void)s_app.r.ui->image_set_source(*icon, dsc);
        if (*shown == 0xFFU) hr_show(&s_app.r, *icon, true);
        *shown = slot;
    }
    s_app.r.ui->obj_set_pos(*icon, x, y);
}

/* ASCII stand-ins until the icon assets arrive over Bluetooth. */
static const char *kind_glyph(uint8_t kind)
{
    switch (kind) {
    case KIND_PROMPT: return "> ";
    case KIND_TOOL: return "* ";
    case KIND_DONE: return "+ ";
    case KIND_ERROR: return "! ";
    case KIND_ASK: return "? ";
    case KIND_NOTIFY: return "~ ";
    case KIND_SYSTEM: return "- ";
    default: return "";
    }
}

static const char *state_name(uint8_t state)
{
    switch (state) {
    case STATE_IDLE: return "idle";
    case STATE_WORKING: return "working";
    case STATE_WAITING: return "waiting for you";
    case STATE_ERROR: return "error";
    default: return "offline";
    }
}

static void draw_rows(void)
{
    uint32_t i;
    bool icons = hr_asset_image(&s_app.assets, KIND_TOOL) != 0;
    for (i = 0; i < MAX_ROWS; ++i) {
        row_t *row = &s_app.rows[i];
        const hist_line_t *line = i < s_app.visible_rows ? hist_line(&s_app.hist, s_app.top + i) : 0;
        int16_t y = (int16_t)(BODY_TOP + (int32_t)i * s_app.line_h);
        if (line == 0) {
            hr_cell_set(&s_app.r, &row->text, "");
            set_icon(&row->icon, &row->icon_slot, s_app.root, 0xFFU, MARGIN, y);
            continue;
        }
        if ((line->flags & HIST_LINE_FIRST) != 0U) {
            set_icon(&row->icon, &row->icon_slot, s_app.root, line->kind, MARGIN,
                     (int16_t)(y + (s_app.line_h - ICON_SIZE) / 2));
        } else {
            set_icon(&row->icon, &row->icon_slot, s_app.root, 0xFFU, MARGIN, y);
        }
        hr_cell_grey(&s_app.r, &row->text,
                     line->kind == KIND_PROMPT || line->kind == KIND_ERROR ? 15U :
                     line->kind == KIND_TOOL || line->kind == KIND_SYSTEM ? 9U : 12U);
        if (!icons && (line->flags & HIST_LINE_FIRST) != 0U && kind_glyph(line->kind)[0] != '\0') {
            s_app.r.libc->snprintf(s_app.line_buf, sizeof(s_app.line_buf), "%s%s",
                                   kind_glyph(line->kind), hist_text(&s_app.hist, line));
            hr_cell_set(&s_app.r, &row->text, s_app.line_buf);
        } else {
            hr_cell_set(&s_app.r, &row->text,
                        line->len == 0U ? " " : hist_text(&s_app.hist, line));
        }
    }
}

static void draw_scrollbar(void)
{
    uint32_t total = s_app.hist.count;
    int32_t track_h = BODY_BOTTOM - BODY_TOP;
    int32_t thumb_h, thumb_y;
    if (total <= s_app.visible_rows || s_app.track == 0) {
        hr_show(&s_app.r, s_app.track, false);
        hr_show(&s_app.r, s_app.thumb, false);
        return;
    }
    thumb_h = track_h * (int32_t)s_app.visible_rows / (int32_t)total;
    if (thumb_h < 12) thumb_h = 12;
    thumb_y = (int32_t)((s_app.top - s_app.hist.first) * (uint32_t)(track_h - thumb_h) /
                        (total - s_app.visible_rows));
    hr_show(&s_app.r, s_app.track, true);
    hr_show(&s_app.r, s_app.thumb, true);
    s_app.r.ui->obj_set_pos(s_app.thumb, SCROLL_X, (int16_t)(BODY_TOP + thumb_y));
    s_app.r.ui->obj_set_size(s_app.thumb, 4, (int16_t)thumb_h);
}

/* Wrap the focused card's detail and show CARD_ROWS lines from card_scroll. */
static void draw_card(ask_t *a)
{
    const gm_plugin_lvgl_api_t *ui = s_app.r.ui;
    const char *p = a->detail;
    uint32_t line = 0U, shown = 0U;
    uint32_t left;
    while (*p != '\0' && shown < CARD_ROWS) {
        gm_plugin_lvgl_coord_t used = 0;
        uint32_t take = ui->text_get_next_line(p, ui->font_default, 0, SCREEN_W - 2 * MARGIN - 24,
                                               &used, GM_PLUGIN_LVGL_TEXT_FLAG_NONE);
        uint32_t len, j;
        if (take == 0U) take = 1U;
        for (j = 0; j < take; ++j) if (p[j] == '\0') { take = j; break; }
        len = take;
        while (len > 0U && (p[len - 1U] == '\n' || p[len - 1U] == ' ')) len--;
        if (line >= s_app.card_scroll) {
            copy_str(s_app.line_buf, sizeof(s_app.line_buf), (const uint8_t *)p, len);
            hr_cell_set(&s_app.r, &s_app.card_rows[shown], len == 0U ? " " : s_app.line_buf);
            shown++;
        }
        line++;
        p += take;
    }
    if (line > 0U && s_app.card_scroll >= line) {
        s_app.card_scroll = (uint16_t)(line - 1U);  /* scrolled past the end */
        s_app.dirty = 1U;
    }
    for (; shown < CARD_ROWS; ++shown) hr_cell_set(&s_app.r, &s_app.card_rows[shown], "");

    hr_cell_set(&s_app.r, &s_app.card_title, a->title);
    s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "%s%s%s",
                           a->risk == RISK_HIGH ? "!! HIGH RISK  " : "",
                           a->project[0] != '\0' ? a->project : "Claude",
                           *p != '\0' ? "   (down: more)" : "");
    hr_cell_set(&s_app.r, &s_app.card_meta, s_app.fmt);

    left = seconds_left(a);
    if (s_app.sending_id == a->id) {
        hr_cell_set(&s_app.r, &s_app.card_hint, "Sending...");
    } else if (a->kind == ASK_LISTEN) {
        hr_cell_set(&s_app.r, &s_app.card_hint, "CLICK talk   SHAKE end");
    } else if (s_app.armed != 0U) {
        uint32_t armed_left = (uint32_t)(s_app.armed_until - now() + 999U) / 1000U;
        s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "PRESS BUTTON to confirm (%us)",
                               (unsigned)armed_left);
        hr_cell_set(&s_app.r, &s_app.card_hint, s_app.fmt);
    } else if (a->kind == ASK_QUESTION) {
        hr_cell_set(&s_app.r, &s_app.card_hint, "NOD yes   SHAKE no   BACK read");
    } else {
        hr_cell_set(&s_app.r, &s_app.card_hint,
                    a->risk == RISK_HIGH ? "NOD, then BUTTON = allow   SHAKE = deny"
                                         : "NOD allow   SHAKE deny   BACK read");
    }
    {
        uint32_t i, n = 0U;
        for (i = 0; i < MAX_ASKS; ++i) n += s_app.asks[i].used;
        if (n > 1U)
            s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "%us  1/%u", (unsigned)left, (unsigned)n);
        else
            s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "%us", (unsigned)left);
        hr_cell_set(&s_app.r, &s_app.card_count, s_app.fmt);
    }
}

static void draw_footer(void)
{
    ask_t *a = focused();
    uint32_t end = hist_end(&s_app.hist);
    if (s_app.toast_until != 0U && (int32_t)(now() - s_app.toast_until) < 0) {
        hr_cell_set(&s_app.r, &s_app.toast, s_app.toast_text);
    } else {
        s_app.toast_until = 0U;
        hr_cell_set(&s_app.r, &s_app.toast, "");
    }
    if (a != 0 && s_app.card_hidden != 0U) {
        hr_cell_set(&s_app.r, &s_app.foot_left, "READING - click to return to the card");
    } else if (s_app.follow != 0U) {
        hr_cell_set(&s_app.r, &s_app.foot_left, s_app.hist.count == 0U ? "" : "LIVE");
    } else {
        uint32_t back = end - (s_app.top + s_app.visible_rows);
        if (s_app.top + s_app.visible_rows > end) back = 0U;
        if (s_app.unread > 0U)
            s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "%u lines back   %u new",
                                   (unsigned)back, (unsigned)s_app.unread);
        else
            s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "%u lines back", (unsigned)back);
        hr_cell_set(&s_app.r, &s_app.foot_left, s_app.fmt);
    }
    if (s_app.hist.count == 0U) {
        hr_cell_set(&s_app.r, &s_app.foot_right, "");
    } else if (s_app.follow != 0U) {
        hr_cell_set(&s_app.r, &s_app.foot_right,
                    hi_raw_active(&s_app.in) ? "ring/click: scroll back" : "click: scroll back");
    } else {
        hr_cell_set(&s_app.r, &s_app.foot_right, "double-click: live");
    }
}

static void draw(void)
{
    ask_t *a = focused();
    bool card = a != 0 && s_app.card_hidden == 0U;
    uint32_t i;
    s_app.dirty = 0U;
    if (s_app.root == 0 || s_app.call_ui != 0U) return;

    /* header */
    set_icon(&s_app.state_icon, &s_app.state_icon_slot, s_app.root,
             s_app.state == STATE_WORKING ? ICON_WORKING :
             s_app.state == STATE_WAITING ? ICON_WAITING :
             s_app.state == STATE_ERROR ? KIND_ERROR : ICON_IDLE,
             MARGIN, HEADER_Y + 2);
    if (s_app.phone_seen == 0U) {
        hr_cell_set(&s_app.r, &s_app.head_left, "Agent Dashboard - open the phone plugin");
    } else if (s_app.head_left_text[0] != '\0') {
        s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "%s - %s", s_app.head_left_text,
                               state_name(s_app.state));
        hr_cell_set(&s_app.r, &s_app.head_left, s_app.fmt);
    } else {
        s_app.r.libc->snprintf(s_app.fmt, sizeof(s_app.fmt), "Claude - %s", state_name(s_app.state));
        hr_cell_set(&s_app.r, &s_app.head_left, s_app.fmt);
    }
    hr_cell_set(&s_app.r, &s_app.head_right, s_app.head_right_text);

    /* waiting summary */
    if (s_app.waiting[0] != '\0') {
        hr_show(&s_app.r, s_app.wait_box, true);
        hr_cell_set(&s_app.r, &s_app.wait_text, s_app.waiting);
    } else {
        hr_show(&s_app.r, s_app.wait_box, false);
        hr_cell_set(&s_app.r, &s_app.wait_text, "");
    }

    if (card) {
        for (i = 0; i < MAX_ROWS; ++i) {
            hr_cell_set(&s_app.r, &s_app.rows[i].text, "");
            set_icon(&s_app.rows[i].icon, &s_app.rows[i].icon_slot, s_app.root, 0xFFU, MARGIN, 0);
        }
        hr_show(&s_app.r, s_app.track, false);
        hr_show(&s_app.r, s_app.thumb, false);
        hr_show(&s_app.r, s_app.card, true);
        draw_card(a);
    } else {
        hr_show(&s_app.r, s_app.card, false);
        if (s_app.hist.count == 0U && s_app.phone_seen != 0U) {
            hr_cell_set(&s_app.r, &s_app.rows[0].text, "No activity yet. Claude Code output appears here.");
            for (i = 1; i < MAX_ROWS; ++i) hr_cell_set(&s_app.r, &s_app.rows[i].text, "");
        } else {
            draw_rows();
        }
        draw_scrollbar();
    }
    draw_footer();
}

/* ---- UI build ------------------------------------------------------------------------ */

static bool build_ui(void)
{
    hr_text_style_t st;
    uint32_t i;
    gm_plugin_lvgl_obj_t *root = s_app.r.ui->root_get();
    if (root == 0) return false;
    s_app.root = root;
    s_app.r.ui->style_set(root, GM_PLUGIN_LVGL_STYLE_BG_COLOR, gm_plugin_lvgl_style_color(0),
                          GM_PLUGIN_LVGL_SELECTOR_MAIN);
    s_app.r.ui->style_set(root, GM_PLUGIN_LVGL_STYLE_BG_OPA,
                          gm_plugin_lvgl_style_number(GM_PLUGIN_LVGL_OPA_COVER),
                          GM_PLUGIN_LVGL_SELECTOR_MAIN);
    s_app.line_h = (int16_t)(s_app.r.ui->font_get_line_height(s_app.r.ui->font_default) + 3);
    if (s_app.line_h < 12) s_app.line_h = 20;
    s_app.visible_rows = (uint8_t)((BODY_BOTTOM - BODY_TOP) / s_app.line_h);
    if (s_app.visible_rows > MAX_ROWS) s_app.visible_rows = MAX_ROWS;
    if (s_app.visible_rows < 3U) s_app.visible_rows = 3U;

    st.font = HR_FONT_DEFAULT;
    st.mode = GM_PLUGIN_LVGL_LABEL_DOT;
    st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_LEFT;
    st.grey = 15U;
    st.x = TEXT_X; st.y = HEADER_Y; st.w = 380; st.h = 22;
    if (!hr_cell_init(&s_app.r, &s_app.head_left, root, &st)) return false;
    st.x = 420; st.w = SCREEN_W - 420 - MARGIN; st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_RIGHT; st.grey = 10U;
    if (!hr_cell_init(&s_app.r, &s_app.head_right, root, &st)) return false;
    if (hr_hline(&s_app.r, root, MARGIN, 27, SCREEN_W - 2 * MARGIN, 1, 4) == 0) return false;

    s_app.wait_box = hr_box(&s_app.r, root, MARGIN, WAIT_Y, SCREEN_W - 2 * MARGIN, WAIT_H, 3, 12, 1, 4);
    if (s_app.wait_box == 0) return false;
    st.x = 8; st.y = 3; st.w = SCREEN_W - 2 * MARGIN - 16; st.h = 20;
    st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_LEFT; st.grey = 15U;
    if (!hr_cell_init(&s_app.r, &s_app.wait_text, s_app.wait_box, &st)) return false;

    st.mode = GM_PLUGIN_LVGL_LABEL_CLIP;
    st.grey = 12U;
    for (i = 0; i < MAX_ROWS; ++i) {
        st.x = TEXT_X; st.y = (int16_t)(BODY_TOP + (int32_t)i * s_app.line_h);
        st.w = TEXT_W; st.h = s_app.line_h;
        if (!hr_cell_init(&s_app.r, &s_app.rows[i].text, root, &st)) return false;
        s_app.rows[i].icon = 0;
        s_app.rows[i].icon_slot = 0xFFU;
    }
    s_app.track = hr_box(&s_app.r, root, SCROLL_X, BODY_TOP, 4, BODY_BOTTOM - BODY_TOP, 2, -1, 0, 2);
    s_app.thumb = hr_box(&s_app.r, root, SCROLL_X, BODY_TOP, 4, 20, 12, -1, 0, 2);
    if (s_app.track == 0 || s_app.thumb == 0) return false;

    if (hr_hline(&s_app.r, root, MARGIN, FOOTER_Y - 3, SCREEN_W - 2 * MARGIN, 1, 4) == 0) return false;
    st.mode = GM_PLUGIN_LVGL_LABEL_DOT;
    st.x = MARGIN; st.y = FOOTER_Y; st.w = 300; st.h = 22; st.grey = 11U;
    if (!hr_cell_init(&s_app.r, &s_app.foot_left, root, &st)) return false;
    st.x = 312; st.w = SCREEN_W - 312 - MARGIN; st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_RIGHT; st.grey = 7U;
    if (!hr_cell_init(&s_app.r, &s_app.foot_right, root, &st)) return false;

    /* approval card */
    s_app.card = hr_box(&s_app.r, root, MARGIN, BODY_TOP, SCREEN_W - 2 * MARGIN,
                        BODY_BOTTOM - BODY_TOP, 1, 15, 2, 8);
    if (s_app.card == 0) return false;
    st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_LEFT;
    st.font = HR_FONT_LARGE; st.grey = 15U;
    st.x = 12; st.y = 8; st.w = SCREEN_W - 2 * MARGIN - 110; st.h = 26;
    if (!hr_cell_init(&s_app.r, &s_app.card_title, s_app.card, &st)) return false;
    st.font = HR_FONT_DEFAULT; st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_RIGHT; st.grey = 10U;
    st.x = SCREEN_W - 2 * MARGIN - 100; st.w = 88; st.h = 22;
    if (!hr_cell_init(&s_app.r, &s_app.card_count, s_app.card, &st)) return false;
    st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_LEFT; st.grey = 9U;
    st.x = 12; st.y = 36; st.w = SCREEN_W - 2 * MARGIN - 24; st.h = 22;
    if (!hr_cell_init(&s_app.r, &s_app.card_meta, s_app.card, &st)) return false;
    st.mode = GM_PLUGIN_LVGL_LABEL_CLIP; st.grey = 13U;
    for (i = 0; i < CARD_ROWS; ++i) {
        st.y = (int16_t)(62 + (int32_t)i * (s_app.line_h > 22 ? 22 : s_app.line_h));
        st.h = s_app.line_h;
        if (!hr_cell_init(&s_app.r, &s_app.card_rows[i], s_app.card, &st)) return false;
    }
    st.mode = GM_PLUGIN_LVGL_LABEL_DOT; st.grey = 15U;
    st.y = BODY_BOTTOM - BODY_TOP - 30; st.h = 22;
    if (!hr_cell_init(&s_app.r, &s_app.card_hint, s_app.card, &st)) return false;
    hr_show(&s_app.r, s_app.card, false);

    /* toast sits over the footer centre */
    st.align = GM_PLUGIN_LVGL_TEXT_ALIGN_CENTER; st.grey = 15U;
    st.x = 150; st.y = FOOTER_Y; st.w = 300; st.h = 22;
    if (!hr_cell_init(&s_app.r, &s_app.toast, root, &st)) return false;
    return true;
}

/* ---- phone call overlay ------------------------------------------------------------------ */

static void on_system(void *context, const gm_plugin_system_event_t *event)
{
    (void)context;
    if (event == 0 || event->struct_size < sizeof(*event) ||
        event->type != GM_PLUGIN_SYSTEM_EVENT_CALL_UI) return;
    s_app.call_ui = event->active ? 1U : 0U;
    hr_show(&s_app.r, s_app.root, !event->active);
    if (!event->active) s_app.dirty = 1U;
}

/* ---- lifecycle ------------------------------------------------------------------------------ */

static gm_plugin_result_t plugin_start(void *context)
{
    char *pool, *scratch;
    hist_line_t *lines;
    (void)context;
    if (g_app == 0) return GM_PLUGIN_ESTATE;
    pool = s_app.host->alloc(HIST_POOL_BYTES);
    lines = s_app.host->alloc(sizeof(hist_line_t) * HIST_MAX_LINES);
    scratch = s_app.host->alloc(HIST_MAX_ENTRY_BYTES + 1U);
    if (pool == 0 || lines == 0 || scratch == 0) {
        if (pool != 0) s_app.host->free(pool);
        if (lines != 0) s_app.host->free(lines);
        if (scratch != 0) s_app.host->free(scratch);
        return GM_PLUGIN_ENOMEM;
    }
    hist_init(&s_app.hist, pool, lines, scratch, wrap_line, 0);
    hr_assets_init(&s_app.assets);
    s_app.state_icon = 0;
    s_app.state_icon_slot = 0xFFU;
    s_app.follow = 1U;
    s_app.head_paging = 1U;
    if (!build_ui()) {
        s_app.r.ui->obj_clean(s_app.r.ui->root_get());
        s_app.host->free(pool);
        s_app.host->free(lines);
        s_app.host->free(scratch);
        s_app.hist.pool = 0;
        return GM_PLUGIN_ENOMEM;
    }
    if (gm_plugin_system_events_get(s_app.host, &s_app.sys) == GM_PLUGIN_OK && s_app.sys != 0)
        (void)s_app.sys->subscribe(on_system, 0);
    if (s_app.host->imu_enable != 0) (void)s_app.host->imu_enable(GM_PLUGIN_IMU_ENABLE_GESTURES);
    hi_start(&s_app.in);
    s_app.started = 1U;
    s_app.connected = 1U;
    s_app.dirty = 1U;
    draw();
    send_hello();
    return GM_PLUGIN_OK;
}

static void plugin_resume(void *context)
{
    (void)context;
    if (g_app == 0) return;
    hi_start(&s_app.in);
    s_app.dirty = 1U;
}

static void plugin_suspend(void *context)
{
    (void)context;
    if (g_app == 0) return;
    hi_stop(&s_app.in);
}

static void plugin_loop(void *context, uint32_t elapsed_ms)
{
    uint32_t t;
    ask_t *a;
    (void)context;
    if (g_app == 0 || s_app.started == 0U) return;
    t = now();
    a = focused();
    /* Keep asking for the phone until it answers (it may start after us). */
    if (s_app.phone_seen == 0U && t - s_app.hello_ms >= HELLO_RETRY_MS) send_hello();
    if (s_app.sending_id != 0U && t - s_app.sending_ms >= ANSWER_TIMEOUT_MS) {
        s_app.sending_id = 0U;
        toast("No reply from phone");
    }
    if (s_app.armed != 0U && (int32_t)(t - s_app.armed_until) > 0) {
        s_app.armed = 0U;
        s_app.dirty = 1U;
    }
    if (a != 0 && a->seconds != 0U && seconds_left(a) == 0U && s_app.sending_id != a->id) {
        drop_ask(a->id);  /* expired; the hook denies on its own timeout */
        toast("Expired - denied");
    }
    if (s_app.toast_until != 0U && (int32_t)(t - s_app.toast_until) >= 0) s_app.dirty = 1U;
    /* Countdown text changes once per second. */
    if (t / 1000U != s_app.last_second) {
        s_app.last_second = t / 1000U;
        if (a != 0 && s_app.card_hidden == 0U) s_app.dirty = 1U;
    }
    s_app.since_frame += elapsed_ms;
    if (s_app.dirty != 0U && s_app.since_frame >= FRAME_MS) {
        s_app.since_frame = 0U;
        draw();
    }
}

static bool plugin_event(void *context, const gm_plugin_event_t *event)
{
    (void)context;
    if (g_app == 0 || event == 0 || s_app.started == 0U) return false;
    if (event->type == GM_PLUGIN_EVENT_BT_MESSAGE) {
        if (event->data.bt.channel != AGENT_CH_DOWN) return false;
        on_message(event->data.bt.data, event->data.bt.length);
        if (s_app.dirty != 0U && s_app.since_frame >= FRAME_MS) {
            s_app.since_frame = 0U;
            draw();
        }
        return true;
    }
    if (event->type == GM_PLUGIN_EVENT_CONNECTION) {
        s_app.connected = event->data.connection.connected ? 1U : 0U;
        if (s_app.connected != 0U) send_hello();
        else toast("Phone disconnected");
        return true;
    }
    if (hi_on_event(&s_app.in, event)) {
        if (s_app.dirty != 0U) {
            s_app.since_frame = 0U;
            draw();  /* input feels instant: redraw now */
        }
        return true;
    }
    return false;
}

static void plugin_stop(void *context)
{
    uint32_t i;
    (void)context;
    if (g_app == 0) return;
    hi_stop(&s_app.in);
    if (s_app.sys != 0) s_app.sys->unsubscribe();
    s_app.sys = 0;
    if (s_app.host->imu_enable != 0) (void)s_app.host->imu_enable(GM_PLUGIN_IMU_ENABLE_NONE);
    if (s_app.root != 0) s_app.r.ui->obj_clean(s_app.root);
    s_app.root = 0;
    s_app.card = 0;
    s_app.wait_box = 0;
    s_app.track = 0;
    s_app.thumb = 0;
    s_app.state_icon = 0;
    for (i = 0; i < MAX_ROWS; ++i) s_app.rows[i].icon = 0;
    hr_assets_free(&s_app.r, &s_app.assets);
    hr_release(&s_app.r);
    if (s_app.hist.pool != 0) {
        /* Agent output is not kept after exit: wipe it before freeing. */
        s_app.r.libc->memset(s_app.hist.pool, 0, HIST_POOL_BYTES);
        s_app.host->free(s_app.hist.pool);
        s_app.host->free(s_app.hist.lines);
        s_app.host->free(s_app.hist.scratch);
        s_app.hist.pool = 0;
    }
    for (i = 0; i < MAX_ASKS; ++i) s_app.asks[i].used = 0U;
    s_app.focus_id = 0U;
    s_app.started = 0U;
}

static gm_plugin_result_t plugin_load(void *context)
{
    const gm_plugin_libc_extension_api_t *libc = 0;
    (void)context;
    if (gm_plugin_libc_get(g_host, &libc) != GM_PLUGIN_OK || libc == 0) return GM_PLUGIN_ENOTSUP;
    g_app = g_host->alloc(sizeof(app_t));
    if (g_app == 0) return GM_PLUGIN_ENOMEM;
    libc->memset(g_app, 0, sizeof(app_t));
    s_app.host = g_host;
    if (hr_init(&s_app.r, g_host) != GM_PLUGIN_OK) {
        g_host->free(g_app);
        g_app = 0;
        return GM_PLUGIN_ENOTSUP;
    }
    hi_init(&s_app.in, g_host, on_action, 0);
    default_keymap(&s_app.in);
    return GM_PLUGIN_OK;
}

static void plugin_unload(void *context)
{
    (void)context;
    if (g_app == 0) return;
    hr_release(&s_app.r);
    g_host->free(g_app);
    g_app = 0;
}

gm_plugin_result_t gm_plugin_entry(const gm_plugin_host_api_t *host,
                                    gm_plugin_descriptor_t *plugin)
{
    if (host == 0 || plugin == 0 ||
        !GM_PLUGIN_VERSION_COMPATIBLE(host->abi_version, GM_PLUGIN_ABI_MIN_VERSION) ||
        host->struct_size < GM_PLUGIN_HOST_API_MIN_SIZE || host->graphics.lvgl == 0 ||
        host->alloc == 0 || host->free == 0 ||
        plugin->struct_size < GM_PLUGIN_DESCRIPTOR_MIN_SIZE)
        return GM_PLUGIN_EVERSION;
    if (host->graphics.lvgl->struct_size < GM_PLUGIN_LVGL_API_MIN_SIZE ||
        !GM_PLUGIN_VERSION_COMPATIBLE(host->graphics.lvgl->api_version,
                                      GM_PLUGIN_LVGL_API_MIN_VERSION))
        return GM_PLUGIN_EVERSION;
    g_host = host;
    g_app = 0;
    plugin->abi_version = GM_PLUGIN_ABI_MIN_VERSION;
    plugin->on_load = plugin_load;
    plugin->on_start = plugin_start;
    plugin->on_resume = plugin_resume;
    plugin->on_suspend = plugin_suspend;
    plugin->on_loop = plugin_loop;
    plugin->on_event = plugin_event;
    plugin->on_stop = plugin_stop;
    plugin->on_unload = plugin_unload;
    return GM_PLUGIN_OK;
}
