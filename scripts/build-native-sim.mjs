// Compiles the glasses plugin for this computer, linked against a fake Host
// (test/native/fake_host.c), so tests can run it without Studio or glasses.
// Uses the reference liblz4 when pkg-config finds it, else a small built-in decoder.
// Needs the GlassSDK headers: MEMOMIND_SDK=/path/to/plugin-open-platform (default ../../../plugin-open-platform).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkRoot } from './sync-sdk.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function buildNativeSim({ quiet = false } = {}) {
  const sdkInclude = resolve(sdkRoot(), 'GlassSDK/include');
  if (!existsSync(resolve(sdkInclude, 'gm_plugin.h'))) {
    throw new Error(`GlassSDK headers not found at ${sdkInclude}. Set MEMOMIND_SDK.`);
  }
  const out = resolve(root, 'test/native/.build');
  mkdirSync(out, { recursive: true });
  const exe = resolve(out, 'agent_hud_sim');
  const glasses = resolve(root, 'glasses');
  const args = [
    '-std=gnu99', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    `-I${sdkInclude}`, `-I${resolve(glasses, 'lib')}`, `-I${resolve(glasses, 'agent_hud')}`,
    resolve(glasses, 'agent_hud/agent_hud.c'),
    resolve(glasses, 'agent_hud/history.c'),
    resolve(glasses, 'agent_hud/libs.c'),
    resolve(root, 'test/native/fake_host.c'),
    resolve(root, 'test/native/sim.c'),
    '-o', exe,
  ];
  const lz4 = spawnSync('pkg-config', ['--cflags', '--libs', 'liblz4'], { encoding: 'utf8' });
  if (lz4.status === 0 && process.env.MEMOMIND_NO_LIBLZ4 !== '1') {
    args.unshift('-DUSE_LIBLZ4', ...lz4.stdout.trim().split(/\s+/).filter((flag) => !flag.startsWith('-l')));
    args.push(...lz4.stdout.trim().split(/\s+/).filter((flag) => flag.startsWith('-l')));
  }
  execFileSync(process.env.CC || 'cc', args, { stdio: quiet ? 'pipe' : 'inherit' });
  return { exe, liblz4: args.includes('-DUSE_LIBLZ4') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { exe, liblz4 } = buildNativeSim();
  console.log(`Built ${exe}${liblz4 ? ' (reference liblz4)' : ' (built-in LZ4 decoder)'}`);
}
