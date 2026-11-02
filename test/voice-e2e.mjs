// Voice end-to-end: live relay + local audio.cpp server + real ffmpeg.
// Plays the phone's role: waits for the "listen" card, downloads Claude's
// speech, then uploads a spoken reply recorded as Ogg Opus (what the glasses
// mic produces), and checks Claude receives the transcript.
//
// Requires macOS `say` to synthesize the "user" voice, ffmpeg, and a running
// audio.cpp server (MEMOMIND_AUDIOCPP_URL, default http://127.0.0.1:8089).
//
//   RELAY_URL=... RELAY_TOKEN=... node test/voice-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../hook/relay.mjs';
import { createVoice, transcode } from '../hook/voice.mjs';
import { createRelayClient } from '../phone/relay-client.js';

const URL_ = process.env.RELAY_URL;
const TOKEN = process.env.RELAY_TOKEN;
assert.ok(URL_ && TOKEN, 'set RELAY_URL and RELAY_TOKEN');
const phone = createRelayClient({ url: URL_, token: TOKEN });
const relay = createRelay({ url: URL_, token: TOKEN });
const voice = createVoice({ relay });

// "The user speaks": macOS TTS → Ogg Opus 16 kHz mono, like the glasses mic.
function userSays(sentence) {
  const dir = mkdtempSync(join(tmpdir(), 'memomind-voice-'));
  try {
    const aiff = join(dir, 'reply.aiff');
    assert.equal(spawnSync('say', ['-o', aiff, sentence]).status, 0, 'macOS say failed');
    return transcode(readFileSync(aiff), ['-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForListen(since, predicate) {
  for (let i = 0; i < 40; i += 1) {
    const feed = await phone.feed(since, 2000);
    const ask = feed.pending.find((item) => item.kind === 'listen' && item.seq > since && predicate(item));
    if (ask) return ask;
  }
  throw new Error('listen card never appeared');
}

// Long-poll from the latest seq so each call actually waits for a change
// (the first speech of a session includes model load time, ~5-15 s).
async function waitForClip(since, askId) {
  let cursor = since;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const feed = await phone.feed(cursor, 5000);
    cursor = feed.seq;
    const ask = feed.pending.find((item) => item.id === askId);
    if (ask?.clipId) return ask.clipId;
  }
  throw new Error('speech clip never attached');
}

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  const started = Date.now();
  await fn();
  console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

assert.ok(await voice.health(), 'audio.cpp server is not running');

await step('Claude speaks: captions + Kokoro audio reach the phone; spoken reply → Qwen3-ASR transcript', async () => {
  const { seq } = await phone.check();
  const turn = voice.converse('## Done\n\nAll **51** tests pass. Want me to open the pull request?', { timeoutS: 90, project: 'voice-e2e' });

  const card = await waitForListen(seq, (item) => item.project === 'voice-e2e');
  assert.match(card.detail, /All 51 tests pass/);
  const clipId = await waitForClip(seq, card.id);
  const speech = await phone.downloadClip(clipId);
  assert.ok(speech.size > 5000, `speech clip too small: ${speech.size}`);
  assert.match(speech.type, /audio\/mpeg/);

  const recorded = await userSays('Yes, open the pull request and ask Dillon for review.');
  const clip = await phone.uploadClip(new Blob([recorded], { type: 'audio/ogg' }));
  await phone.answer(card.id, 'reply', 'voice', { clipId: clip.id });

  const result = await turn;
  assert.equal(result.via, 'voice');
  assert.match(result.text.toLowerCase(), /open the pull request/);
  console.log(`\n    transcript: "${result.text}"`);
});

await step('typed reply skips speech-to-text', async () => {
  const { seq } = await phone.check();
  const turn = voice.converse('Which branch?', { timeoutS: 60, project: 'voice-e2e-typed' });
  const card = await waitForListen(seq, (item) => item.project === 'voice-e2e-typed');
  await phone.answer(card.id, 'reply', 'typed', { text: 'feat/agent-dashboard' });
  assert.deepEqual(await turn, { text: 'feat/agent-dashboard', via: 'typed' });
});

await step('shake ends the conversation (no text)', async () => {
  const { seq } = await phone.check();
  const turn = voice.converse('Anything else?', { timeoutS: 60, project: 'voice-e2e-end' });
  const card = await waitForListen(seq, (item) => item.project === 'voice-e2e-end');
  await phone.answer(card.id, 'deny', 'shake');
  assert.equal((await turn).text, null);
});

await step('Stop hook in voice mode: spoken reply becomes the next instruction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memomind-flag-'));
  const flag = join(dir, 'voice-mode');
  spawnSync('touch', [flag]);
  try {
    const { seq } = await phone.check();
    const hook = spawn(process.execPath, [fileURLToPath(new URL('../hook/memomind-voice-hook.mjs', import.meta.url))], {
      env: { ...process.env, MEMOMIND_RELAY_URL: URL_, MEMOMIND_RELAY_TOKEN: TOKEN, MEMOMIND_VOICE_FLAG: flag, MEMOMIND_VOICE_TIMEOUT: '60' },
    });
    let stdout = '';
    hook.stdout.on('data', (d) => { stdout += d; });
    const done = new Promise((resolve) => hook.on('close', resolve));
    hook.stdin.end(JSON.stringify({
      hook_event_name: 'Stop', session_id: 'voicee2e-0001', cwd: '/Users/me/voice-hook-e2e',
      last_assistant_message: 'I renamed the function. Should I also update the docs?',
    }));
    const card = await waitForListen(seq, (item) => item.project === 'voice-hook-e2e');
    const recorded = await userSays('Yes, update the docs too.');
    const clip = await phone.uploadClip(new Blob([recorded], { type: 'audio/ogg' }));
    await phone.answer(card.id, 'reply', 'voice', { clipId: clip.id });
    await done;
    const output = JSON.parse(stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason.toLowerCase(), /update the docs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await step('Stop hook with voice mode off exits immediately with no output', async () => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hook/memomind-voice-hook.mjs', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'hi' }),
    env: { ...process.env, MEMOMIND_RELAY_URL: URL_, MEMOMIND_RELAY_TOKEN: TOKEN, MEMOMIND_VOICE_FLAG: '/nonexistent/voice-mode' },
  });
  assert.equal(result.stdout.toString(), '');
  assert.ok(Date.now() - started < 2000);
});

console.log('\nAll voice end-to-end checks passed.');
