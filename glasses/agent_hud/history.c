#include "history.h"

void hist_init(hist_t *h, char *pool, hist_line_t *lines, char *scratch,
               hist_wrap_fn wrap, void *wrap_context)
{
    h->pool = pool;
    h->lines = lines;
    h->scratch = scratch;
    h->wrap = wrap;
    h->wrap_context = wrap_context;
    hist_reset(h);
}

void hist_reset(hist_t *h)
{
    h->first = 0U;
    h->count = 0U;
    h->head = 0U;
    h->tail = 0U;
    h->last_seq = 0U;
    h->dropped = 0U;
    h->entries = 0U;
    h->wrapped = 0U;
}

const hist_line_t *hist_line(const hist_t *h, uint32_t number)
{
    if (number < h->first || number >= h->first + h->count) return 0;
    return &h->lines[number % HIST_MAX_LINES];
}

static void evict(hist_t *h)
{
    uint32_t old_tail = h->tail;
    if (h->count == 0U) return;
    h->first++;
    h->count--;
    h->dropped++;
    if (h->count == 0U) {
        h->head = 0U;
        h->tail = 0U;
        h->wrapped = 0U;
    } else {
        h->tail = h->lines[h->first % HIST_MAX_LINES].off;
        if (h->tail < old_tail) h->wrapped = 0U;  /* tail followed head to the start */
    }
    /* The oldest entry is gone once the new oldest line starts another one. */
    if (h->entries > 0U &&
        (h->count == 0U || (h->lines[h->first % HIST_MAX_LINES].flags & HIST_LINE_FIRST) != 0U))
        h->entries--;
}

/* Drop whole entries until there is room for one more. */
static void trim_entries(hist_t *h)
{
    while (h->count > 0U && h->entries >= HIST_MAX_ENTRIES) {
        uint32_t before = h->entries;
        while (h->count > 0U && h->entries == before) evict(h);
    }
    if (h->count == 0U) h->entries = 0U;
}

/* Reserve n contiguous bytes, dropping the oldest lines as needed. */
static uint32_t reserve(hist_t *h, uint32_t n)
{
    for (;;) {
        if (h->count == 0U) {
            h->head = 0U;
            h->tail = 0U;
            h->wrapped = 0U;
            return 0U;
        }
        if (h->wrapped == 0U) {            /* used: [tail, head) */
            if (h->head + n <= HIST_POOL_BYTES) return h->head;
            if (n <= h->tail) {            /* wrap to the start */
                h->wrapped = 1U;
                return 0U;
            }
        } else {                           /* used: [tail, end) + [0, head) */
            if (h->head + n <= h->tail) return h->head;
        }
        evict(h);
    }
}

static void push_line(hist_t *h, uint8_t kind, uint8_t flags, const char *text, uint32_t len)
{
    uint32_t at, i;
    hist_line_t *line;
    if (len > 1023U) len = 1023U;
    if (h->count == HIST_MAX_LINES) evict(h);
    at = reserve(h, len + 1U);
    for (i = 0; i < len; ++i) h->pool[at + i] = text[i];
    h->pool[at + len] = '\0';
    h->head = at + len + 1U;
    if (h->count == 0U) h->tail = at;
    line = &h->lines[(h->first + h->count) % HIST_MAX_LINES];
    line->off = at;
    line->len = (uint16_t)len;
    line->kind = kind;
    line->flags = flags;
    h->count++;
}

/* Length of one UTF-8 sequence starting at p (at least 1). */
static uint32_t utf8_step(const char *p)
{
    uint8_t c = (uint8_t)*p;
    uint32_t n = c < 0x80U ? 1U : (c >> 5) == 6U ? 2U : (c >> 4) == 14U ? 3U : (c >> 3) == 30U ? 4U : 1U;
    uint32_t i;
    for (i = 1; i < n; ++i)
        if (p[i] == '\0') return i;
    return n;
}

uint32_t hist_append(hist_t *h, uint8_t kind, const char *utf8, uint32_t length)
{
    uint32_t i, n = 0U, added = 0U, blank_run = 0U;
    const char *p;
    uint8_t flags = HIST_LINE_FIRST;
    if (length > HIST_MAX_ENTRY_BYTES) length = HIST_MAX_ENTRY_BYTES;
    trim_entries(h);
    h->entries++;
    /* Copy, turning tabs/CR/control bytes into spaces so wrapping is stable. */
    for (i = 0; i < length && utf8[i] != '\0'; ++i) {
        char c = utf8[i];
        if (c == '\r') continue;
        if (c == '\t' || ((uint8_t)c < 0x20U && c != '\n')) c = ' ';
        h->scratch[n++] = c;
    }
    h->scratch[n] = '\0';
    p = h->scratch;
    if (*p == '\0') {
        push_line(h, kind, flags, "", 0U);
        return 1U;
    }
    while (*p != '\0') {
        uint32_t take = h->wrap != 0 ? h->wrap(h->wrap_context, p) : 0U;
        uint32_t len, j;
        if (take == 0U) take = utf8_step(p);  /* always make progress */
        for (j = 0; j < take; ++j)
            if (p[j] == '\0') { take = j; break; }
        len = take;
        while (len > 0U && (p[len - 1U] == '\n' || p[len - 1U] == ' ')) len--;
        if (len == 0U) {
            /* Keep at most one blank line in a row; never start with one. */
            if (added == 0U || blank_run >= 1U) { p += take; continue; }
            blank_run++;
        } else {
            blank_run = 0U;
        }
        push_line(h, kind, flags, p, len);
        flags = 0U;
        added++;
        p += take;
        /* Leading spaces after a soft wrap would indent the next line. */
        if (take > 0U && p[-1] != '\n')
            while (*p == ' ') p++;
    }
    if (added == 0U) {
        push_line(h, kind, HIST_LINE_FIRST, "", 0U);
        added = 1U;
    }
    return added;
}
