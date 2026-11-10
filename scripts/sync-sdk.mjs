// Copies the MemoMind Web SDK into phone/vendor/ from your local
// plugin-open-platform checkout. The SDK is MemoMind's property (see their
// Developer Platform Terms §10.1), so it is generated locally rather than
// committed to this repository.
//
// Usage: MEMOMIND_SDK=/path/to/plugin-open-platform node scripts/sync-sdk.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sdkRoot() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return resolve(process.env.MEMOMIND_SDK || resolve(root, '../plugin-open-platform'));
}

export async function syncSdk() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const phoneSdk = resolve(sdkRoot(), 'PhoneSDK');
  const bundler = resolve(phoneSdk, 'tools/bundle-phone-sdk.mjs');
  if (!existsSync(bundler)) {
    throw new Error(`PhoneSDK not found at ${phoneSdk}\nClone https://github.com/memomind-open/plugin-open-platform and set MEMOMIND_SDK to it.`);
  }
  const { bundlePhoneSdk } = await import(pathToFileURL(bundler));
  const { version } = JSON.parse(readFileSync(resolve(phoneSdk, 'package.json'), 'utf8'));
  const output = resolve(root, 'phone/vendor/gm-plugin-web-sdk.esm.js');
  mkdirSync(resolve(root, 'phone/vendor'), { recursive: true });
  writeFileSync(output, await bundlePhoneSdk(phoneSdk, version));
  return { output, version };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { output, version } = await syncSdk();
  console.log(`MemoMind Web SDK ${version} → ${output}`);
}
