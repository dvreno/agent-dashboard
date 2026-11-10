/*
 * Short reading window: a ring of already-wrapped display lines.
 *
 * MemoMind's design guidance keeps long history on the phone, so the glasses
 * hold only the last HIST_MAX_ENTRIES events; the phone page has the full log.
 *
 * Entries (one agent event or message) are wrapped to the body width once, when
 * they arrive, and stored as NUL-terminated lines in a fixed text pool. When the
 * pool or the line table is full the oldest lines are dropped. Lines have
 * absolute numbers that only grow, so a reader position survives new output.
 */
#ifndef AGENT_HISTORY_H
#define AGENT_HISTORY_H

#include <stdbool.h>
#include <stdint.h>

#define HIST_MAX_ENTRIES 12U     /* events kept on the glasses */
#define HIST_POOL_BYTES 6144U
#define HIST_MAX_LINES 160U
#define HIST_MAX_ENTRY_BYTES 1024U   /* the phone cuts longer text and says so */

#define HIST_LINE_FIRST 0x01U   /* first line of its entry (gets the icon) */

typedef struct {
    uint32_t off;               /* byte offset in pool */
    uint16_t len;               /* bytes, excluding NUL */
    uint8_t kind;
    uint8_t flags;
} hist_line_t;

/* Return the byte length of the first display line of utf8 (which is
 * NUL-terminated), including the break character if any. 0 = end. */
typedef uint32_t (*hist_wrap_fn)(void *context, const char *utf8);

typedef struct {
    char *pool;                 /* HIST_POOL_BYTES */
    hist_line_t *lines;         /* HIST_MAX_LINES */
    char *scratch;              /* HIST_MAX_ENTRY_BYTES + 1 */
    hist_wrap_fn wrap;
    void *wrap_context;
    uint32_t first;             /* absolute number of the oldest stored line */
    uint32_t count;             /* stored lines */
    uint32_t head;              /* next free pool byte */
    uint32_t tail;              /* pool offset of the oldest line */
    uint32_t last_seq;          /* newest entry sequence number received */
    uint32_t dropped;           /* lines evicted since reset */
    uint32_t entries;           /* entries with at least one stored line */
    uint8_t wrapped;            /* live text continues from the pool start */
} hist_t;

/* Buffers are supplied by the caller (host->alloc on glasses, static in tests). */
void hist_init(hist_t *h, char *pool, hist_line_t *lines, char *scratch,
               hist_wrap_fn wrap, void *wrap_context);
void hist_reset(hist_t *h);

/* Wrap and append one entry. Returns the number of display lines added. */
uint32_t hist_append(hist_t *h, uint8_t kind, const char *utf8, uint32_t length);

/* Absolute number one past the newest line. */
static inline uint32_t hist_end(const hist_t *h) { return h->first + h->count; }

/* Line by absolute number, or NULL when it has been dropped / not written. */
const hist_line_t *hist_line(const hist_t *h, uint32_t number);
static inline const char *hist_text(const hist_t *h, const hist_line_t *line)
{
    return h->pool + line->off;
}

#endif
