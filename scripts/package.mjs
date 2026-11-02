// Builds dist/agent-dashboard-<version>.mmpkg with the official PhoneSDK packager.
// Usage: MEMOMIND_SDK=/path/to/plugin-open-platform npm run package
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sdk = resolve(process.env.MEMOMIND_SDK || resolve(root, '../../../plugin-open-platform'));
const packager = resolve(sdk, 'PhoneSDK/tools/build-mmpkg.mjs');
if (!existsSync(packager)) {
  console.error(`PhoneSDK packager not found at ${packager}\nSet MEMOMIND_SDK to your plugin-open-platform checkout.`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(resolve(root, 'phone/manifest.json'), 'utf8'));
mkdirSync(resolve(root, 'dist'), { recursive: true });
const output = resolve(root, `dist/agent-dashboard-${version}.mmpkg`);
execFileSync(process.execPath, [packager, resolve(root, 'phone'), output], { stdio: 'inherit' });
console.log(`Built ${output}`);
