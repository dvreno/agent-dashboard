#!/usr/bin/env node
// Toggle MemoMind voice mode for Claude Code.
//   node ~/.claude/memomind/voicectl.mjs on|off|status
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { VOICE_FLAG } from './voice.mjs';

const command = process.argv[2] || 'status';
if (command === 'on') {
  mkdirSync(dirname(VOICE_FLAG), { recursive: true });
  writeFileSync(VOICE_FLAG, `${new Date().toISOString()}\n`);
} else if (command === 'off') {
  rmSync(VOICE_FLAG, { force: true });
} else if (command !== 'status') {
  console.error('usage: voicectl.mjs on|off|status');
  process.exit(2);
}
console.log(`MemoMind voice mode is ${existsSync(VOICE_FLAG) ? 'ON: Claude will speak replies and listen on the glasses' : 'OFF'}`);
