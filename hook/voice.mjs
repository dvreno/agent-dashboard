// Voice bridge: Claude's words → audio.cpp text-to-speech → glasses, and the
// wearer's recorded reply → audio.cpp speech-to-text → text for Claude.
// Runs on the Mac (next to Claude Code); the phone only records and plays.
//
// Configuration:
//   MEMOMIND_AUDIOCPP_URL   audio.cpp server (default http://127.0.0.1:8089)
//   MEMOMIND_TTS_MODEL      server model id for TTS (default "kokoro")
//   MEMOMIND_TTS_VOICE      voice id (default: the server's preset, e.g. af_heart)
//   MEMOMIND_ASR_MODEL      server model id for speech-to-text (default "qwen3-asr")
//   MEMOMIND_FFMPEG         ffmpeg binary (default "ffmpeg" on PATH, or /opt/homebrew/bin/ffmpeg)
//   MEMOMIND_TTS            set to "off" for captions only (replies are still transcribed)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Voice mode is on while this file exists (toggled by voicectl.mjs).
export const VOICE_FLAG = join(homedir(), '.claude', 'memomind', 'voice-mode');

export const SPEECH_MAX_CHARS = 600;
export const CAPTION_MAX_CHARS = 2000;

// Turn Claude's Markdown into something pleasant to *hear*.
export function toSpeech(markdown, max = SPEECH_MAX_CHARS) {
  let text = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/[*_~>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  // Cut at the last sentence end that fits, else at a word boundary.
  const slice = text.slice(0, max);
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
  text = sentenceEnd > max * 0.5 ? slice.slice(0, sentenceEnd + 1) : `${slice.slice(0, slice.lastIndexOf(' '))}…`;
  return `${text} The rest is on your screen.`;
}

// Captions keep more detail but drop Markdown noise; the HUD pages through them.
export function toCaptions(markdown, max = CAPTION_MAX_CHARS) {
  const text = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ffmpegBinary(env) {
  if (env.MEMOMIND_FFMPEG) return env.MEMOMIND_FFMPEG;
  return existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
}

// Pipe bytes through ffmpeg (stdin → stdout).
export function transcode(bytes, args, { ffmpeg = 'ffmpeg', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1']);
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input
    child.stdin.end(bytes);
  });
}

// Wrap raw 16-bit little-endian mono PCM in a WAV header. (ffmpeg cannot fill
// in WAV chunk sizes when writing to a pipe, and audio.cpp rejects that.)
export function pcmToWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createVoice({ relay, env = process.env, fetchImpl = fetch, log = () => {} }) {
  const server = (env.MEMOMIND_AUDIOCPP_URL || 'http://127.0.0.1:8089').replace(/\/+$/, '');
  const ttsModel = env.MEMOMIND_TTS_MODEL || 'kokoro';
  const asrModel = env.MEMOMIND_ASR_MODEL || 'qwen3-asr';
  const voice = env.MEMOMIND_TTS_VOICE || '';
  const speakAloud = env.MEMOMIND_TTS !== 'off';
  const ffmpeg = ffmpegBinary(env);

  async function synthesize(text) {
    const response = await fetchImpl(`${server}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ttsModel, input: text, ...(voice ? { voice } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`TTS ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const wav = Buffer.from(await response.arrayBuffer());
    // MP3 plays in every phone WebView and is ~10x smaller than WAV.
    return transcode(wav, ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3'], { ffmpeg });
  }

  async function transcribe(bytes) {
    const pcm = await transcode(bytes, ['-ar', '16000', '-ac', '1', '-f', 's16le'], { ffmpeg });
    if (pcm.length < 3200) return ''; // under 0.1 s: nothing was said
    const wav = pcmToWav(pcm);
    const form = new FormData();
    form.append('model', asrModel);
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'reply.wav');
    const response = await fetchImpl(`${server}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`ASR ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    return String(data.text || '').trim();
  }

  async function health() {
    const response = await fetchImpl(`${server}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  }

  // One conversational turn: show + speak `message`, wait for the wearer's reply.
  // Resolves to { text, via } when they replied, or { text: null, state } when
  // they ended the conversation (shake), didn't answer in time, or it was cancelled.
  async function converse(message, { timeoutS = 180, project = '', session = '', signal } = {}) {
    const speech = toSpeech(message);
    let speaking = Promise.resolve();
    const result = await relay.askAndWait({
      kind: 'listen',
      session,
      project,
      title: 'Claude',
      detail: toCaptions(message),
    }, timeoutS, {
      log,
      signal,
      // Captions appear immediately; audio is attached as soon as it is ready.
      onCreated: (ask) => {
        speaking = (async () => {
          if (!speech || !speakAloud) return;
          const audio = await synthesize(speech);
          const clip = await relay.uploadClip(audio, 'audio/mpeg');
          await relay.attachClip(ask.id, clip.id);
          log(`speech attached (${audio.length} bytes)`);
        })().catch((error) => log(`speech failed: ${error.message}`));
      },
    });
    await speaking;

    if (result.state !== 'reply' || !result.reply) return { text: null, state: result.state };
    if (result.reply.text) return { text: result.reply.text, via: 'typed' };
    const { bytes } = await relay.downloadClip(result.reply.clipId);
    const text = await transcribe(bytes);
    return { text: text || null, state: text ? 'reply' : 'empty', via: 'voice' };
  }

  return { synthesize, transcribe, converse, health };
}
