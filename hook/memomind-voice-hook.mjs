#!/usr/bin/env node
// Claude Code Stop hook for voice mode. When voice mode is on, each time Claude
// finishes a turn its reply is spoken on the MemoMind glasses (with captions)
// and the hook waits for the wearer's spoken reply. If they answer, the reply
// is handed back to the same session as the next instruction ("decision":
// "block"); if they shake their head or stay silent, the session stops normally.
//
// Voice mode is off unless ~/.claude/memomind/voice-mode exists (see voicectl.mjs),
// so with it off this hook exits immediately and never delays Claude.
//
//   MEMOMIND_VOICE_TIMEOUT  seconds to wait for a reply (default 180)

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createRelay, relayConfig } from './relay.mjs';
import { createVoice, VOICE_FLAG } from './voice.mjs';

function log(message) {
  if (process.env.MEMOMIND_DEBUG) process.stderr.write(`[memomind-voice] ${message}\n`);
}

export function stopOutput(text) {
  return {
    decision: 'block',
    reason: `The user replied by voice from their MemoMind glasses: "${text.replace(/"/g, '\\"')}"\n`
      + 'Respond to that. Your reply will be read aloud on the glasses, so lead with a short spoken '
      + 'answer (one to three sentences) before any detail, and avoid long code blocks unless asked.',
  };
}

async function main() {
  if (process.env.MEMOMIND_DISABLED === '1' || !existsSync(process.env.MEMOMIND_VOICE_FLAG || VOICE_FLAG)) return;
  const config = relayConfig();
  if (!config.url || !config.token) return;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (input.hook_event_name !== 'Stop' || !input.last_assistant_message) return;

  const voice = createVoice({ relay: createRelay(config), log });
  const timeoutS = Math.min(Math.max(Number(process.env.MEMOMIND_VOICE_TIMEOUT) || 180, 15), 570);
  const result = await voice.converse(input.last_assistant_message, {
    timeoutS,
    project: input.cwd ? basename(input.cwd) : '',
    session: String(input.session_id || '').slice(0, 8),
  });
  log(`turn ended: ${result.state || 'reply'}`);
  if (result.text) process.stdout.write(JSON.stringify(stopOutput(result.text)));
}

main().catch((error) => {
  // Never trap the session: any failure lets Claude stop normally.
  log(error.stack || String(error));
  process.exitCode = 0;
});
