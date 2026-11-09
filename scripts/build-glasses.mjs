// Builds the glasses plugin (glasses/agent_hud) with the official GlassSDK
// build.py, which also writes the review sidecars Studio needs for device
// delivery, then copies the three artifacts plus manifest.json to dist/.
//
// Usage: MEMOMIND_SDK=/path/to/plugin-open-platform npm run build:glasses
// Python needs PyNaCl (python3 -m pip install PyNaCl); set PYTHON to pick an
// interpreter, e.g. PYTHON=~/.cache/GMPluginSDK/venv/bin/python.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkRoot } from './sync-sdk.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FLASH_LIMIT = 512_000;

export function buildGlasses() {
  const sdk = resolve(sdkRoot(), 'GlassSDK');
  const buildPy = resolve(sdk, 'build.py');
  if (!existsSync(buildPy)) throw new Error(`GlassSDK not found at ${sdk}. Set MEMOMIND_SDK.`);
  const glasses = resolve(root, 'glasses');
  const project = resolve(glasses, 'agent_hud');
  const python = process.env.PYTHON || 'python3';
  execFileSync(python, [buildPy, 'build', '--project', project, '--source-root', glasses,
    '--include-dir', resolve(glasses, 'lib')], { cwd: sdk, stdio: 'inherit' });
  const out = resolve(project, '.build/agent_hud');
  const dist = resolve(root, 'dist');
  mkdirSync(dist, { recursive: true });
  const files = ['agent_hud.gmp', 'agent_hud.review.json', 'agent_hud.review-source.enc'];
  for (const name of files) {
    if (!existsSync(resolve(out, name))) throw new Error(`build.py did not produce ${name}`);
    copyFileSync(resolve(out, name), resolve(dist, name));
  }
  copyFileSync(resolve(project, 'manifest.json'), resolve(dist, 'manifest.json'));
  const size = statSync(resolve(dist, 'agent_hud.gmp')).size;
  if (size > FLASH_LIMIT / 2) console.warn(`warning: agent_hud.gmp is ${size} B; keep it well under 500 KiB`);
  return { dist, size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dist, size } = buildGlasses();
  console.log(`Glasses plugin: ${resolve(dist, 'agent_hud.gmp')} (${size} B) + review sidecars`);
}
