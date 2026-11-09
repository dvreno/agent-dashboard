/*
 * Agent Dashboard phone <-> glasses protocol, version 1.
 *
 * Application messages (GM service 0x0F) on two channels. Every message starts
 * with one command byte; integers are little-endian; strings are UTF-8 with an
 * explicit length (no terminator). The phone side lives in phone/native-link.js
 * and must stay byte-for-byte in sync with this file.
 */
#ifndef AGENT_PROTO_H
#define AGENT_PROTO_H

#define AGENT_PROTO_VERSION 1U
#define AGENT_CH_DOWN 0x4144U  /* phone -> glasses ("AD") */
#define AGENT_CH_UP 0x4145U    /* glasses -> phone */

/* phone -> glasses */
#define CMD_HELLO_REQ 0x01U    /* u8 version. Glasses answer with EVT_HELLO. */
#define CMD_ENTRIES 0x02U      /* u32 first_seq, u8 count, count x { u8 kind,
                                  u8 flags, u16 len, bytes } */
#define CMD_STATUS 0x03U       /* u8 state, u8 sessions, u8 len + header_left,
                                  u8 len + header_right, u16 len + waiting */
#define CMD_ASK 0x04U          /* u32 id, u8 risk, u8 kind, u16 seconds_left,
                                  u8 len + title, u8 len + project,
                                  u16 len + detail */
#define CMD_ASK_CLEAR 0x05U    /* u32 id (0 = every card) */
#define CMD_RESET 0x06U        /* forget history (relay changed) */
#define CMD_ASSET_BEGIN 0x07U  /* hud_render ASSET_BEGIN body */
#define CMD_ASSET_TILE 0x08U   /* hud_render ASSET_TILE body */
#define CMD_FB_TILE 0x09U      /* hud_render FB_TILE body (generic, unused) */
#define CMD_CONFIG 0x0AU       /* u8 raw_mode, u8 wheel_step, u8 head_paging,
                                  u8 n, n x { u8 hi_input, u8 action } */
#define CMD_ANSWER_ACK 0x0BU   /* u32 id, u8 ok */
#define CMD_NOTICE 0x0CU       /* u8 len + text: short toast */

/* glasses -> phone */
#define EVT_HELLO 0x81U        /* u8 version, u16 width, u16 height, u8 flags,
                                  u32 last_seq, u8 n, n x u32 asset hash */
#define EVT_ANSWER 0x82U       /* u32 id, u8 decision, u8 via */
#define EVT_NEED 0x83U         /* u32 from_seq: history gap, resend from here */
#define EVT_ASSET 0x84U        /* u8 slot, i8 hud_render result */
#define EVT_INPUT 0x85U        /* u8 hi_input, u8 hi_source, u8 action */
#define EVT_VIEW 0x86U         /* u8 mode, u32 top, u32 total, u32 unread */

/* EVT_HELLO flags */
#define HELLO_RAW_INPUT 0x01U  /* raw HOGP input subscription live */
#define HELLO_LZ4 0x02U        /* LZ4 extension available */

/* Entry kinds (also asset slot numbers of their icons). */
#define KIND_PROMPT 0U
#define KIND_TOOL 1U
#define KIND_TEXT 2U
#define KIND_DONE 3U
#define KIND_ERROR 4U
#define KIND_ASK 5U
#define KIND_NOTIFY 6U
#define KIND_SYSTEM 7U
#define KIND_COUNT 8U

/* Extra icon slots. */
#define ICON_WORKING 8U
#define ICON_IDLE 9U
#define ICON_WAITING 10U
#define ICON_RING 11U
#define ICON_COUNT 12U

/* Session state in CMD_STATUS. */
#define STATE_OFFLINE 0U
#define STATE_IDLE 1U
#define STATE_WORKING 2U
#define STATE_WAITING 3U
#define STATE_ERROR 4U

/* Ask risk / kind. */
#define RISK_NORMAL 0U
#define RISK_HIGH 1U
#define ASK_PERMISSION 0U
#define ASK_QUESTION 1U
#define ASK_LISTEN 2U          /* voice conversation turn */

/* EVT_ANSWER decision / via. */
#define DECISION_ALLOW 1U
#define DECISION_DENY 2U
#define DECISION_TALK 3U       /* listen card: start/stop recording on the phone */
#define VIA_NOD 1U
#define VIA_SHAKE 2U
#define VIA_BUTTON 3U
#define VIA_RING 4U

/* EVT_VIEW mode. */
#define VIEW_LIVE 0U
#define VIEW_HISTORY 1U
#define VIEW_CARD 2U

#endif
