// Builds dist/agent-dashboard-<version>.mmpkg with the official PhoneSDK packager.
// Refreshes phone/vendor/ from your SDK checkout first.
// Usage: MEMOMIND_SDK=/path/to/plugin-open-platform npm run package
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkRoot, syncSdk } from './sync-sdk.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
await syncSdk();
const packager = resolve(sdkRoot(), 'PhoneSDK/tools/build-mmpkg.mjs');
const { version } = JSON.parse(readFileSync(resolve(root, 'phone/manifest.json'), 'utf8'));
mkdirSync(resolve(root, 'dist'), { recursive: true });
const output = resolve(root, `dist/agent-dashboard-${version}.mmpkg`);
execFileSync(process.execPath, [packager, resolve(root, 'phone'), output], { stdio: 'inherit' });
console.log(`Built ${output}`);
