// Browser Studio smoke test: loads the phone plugin in the PhoneSDK Browser
// Studio (virtual glasses), connects it to a running relay, triggers a real
// hook PermissionRequest, answers it with a simulated nod, and saves screenshots.
//
// Prereqs: relay running (wrangler dev), Browser Studio running with this plugin:
//   node <SDK>/PhoneSDK/tools/run-browser-studio.mjs --plugin <repo>/phone --port 4173
// Run:
//   RELAY_TOKEN=... STUDIO_URL=http://127.0.0.1:4173 OUT_DIR=/tmp node test/studio-smoke.mjs

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.RELAY_TOKEN;
const OUT = process.env.OUT_DIR || '.';
assert.ok(TOKEN, 'set RELAY_TOKEN');
const HOOK = fileURLToPath(new URL('../hook/memomind-hook.mjs', import.meta.url));

function runHook(payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, MEMOMIND_RELAY_URL: RELAY, MEMOMIND_RELAY_TOKEN: TOKEN } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => resolve(stdout));
    child.stdin.end(JSON.stringify(payload));
  });
}

// Studio only has up/down/left/right buttons; relabel one to emit nod/shake.
async function gesture(page, name) {
  await page.evaluate((g) => {
    const button = document.querySelector('[data-gesture="left"]');
    button.dataset.gesture = g;
    button.click();
    button.dataset.gesture = 'left';
  }, name);
}

// Start from a clean relay: deny anything left pending by earlier runs, so the
// nod below answers the card this test creates (the HUD always shows the oldest).
{
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const feed = await (await fetch(`${RELAY}/v1/feed?since=0&wait=0`, { headers })).json();
  for (const ask of feed.pending) {
    await fetch(`${RELAY}/v1/asks/${ask.id}/answer`, { method: 'POST', headers, body: JSON.stringify({ decision: 'deny', via: 'test-cleanup' }) });
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('dialog', (dialog) => dialog.accept());
const logs = [];
page.on('console', (message) => logs.push(message.text()));
await page.goto(STUDIO);

// Approve the debug permission prompt if Studio shows one.
// The Studio consent dialog may be in Chinese: 按所选权限启动 = "Start with selected permissions".
const approve = page.getByRole('button', { name: /按所选权限启动|start with|approve|allow|grant|confirm/i }).first();
if (await approve.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
  // Tick every requested permission, then start.
  for (const box of await page.locator('dialog input[type=checkbox], [role=dialog] input[type=checkbox]').all()) await box.check();
  await approve.click();
}

const frame = page.frameLocator('#plugin-frame');
await frame.locator('#relay-url').fill(RELAY);
await frame.locator('#relay-token').fill(TOKEN);
await frame.locator('#save').click();
await frame.locator('#connection[data-state="online"]').waitFor({ timeout: 15000 });

await runHook({ hook_event_name: 'SessionStart', session_id: 'studio-smoke-01', cwd: '/Users/me/memomind-plugins', source: 'startup' });
await runHook({ hook_event_name: 'PostToolUse', session_id: 'studio-smoke-01', cwd: '/Users/me/memomind-plugins', tool_name: 'Edit', tool_input: { file_path: '/Users/me/memomind-plugins/src/app.js' } });
await page.waitForTimeout(2500);
await page.locator('#device-canvas').screenshot({ path: `${OUT}/hud-status.png` });

// Normal-risk ask answered by nod.
const hook = runHook({
  hook_event_name: 'PermissionRequest', session_id: 'studio-smoke-01', cwd: '/Users/me/memomind-plugins',
  tool_name: 'Bash', tool_input: { command: 'npm run build' },
});
await frame.locator('.ask').first().filter({ hasText: 'npm run build' }).waitFor({ timeout: 15000 });
await page.waitForTimeout(1500); // let the card settle (gestures ignored for 800 ms)
await page.locator('#device-canvas').screenshot({ path: `${OUT}/hud-ask.png` });
await gesture(page, 'nod');
const output = JSON.parse(await hook);
assert.equal(output.hookSpecificOutput.decision.behavior, 'allow');
console.log('• nod in Studio → Claude Code allow ✓');

// High-risk ask: nod arms, button confirms.
const risky = runHook({
  hook_event_name: 'PermissionRequest', session_id: 'studio-smoke-01', cwd: '/Users/me/memomind-plugins',
  tool_name: 'Bash', tool_input: { command: 'git push --force origin main' },
});
await frame.locator('.ask').first().filter({ hasText: 'git push --force' }).waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
await gesture(page, 'nod');
await page.waitForTimeout(800);
await page.locator('#device-canvas').screenshot({ path: `${OUT}/hud-confirm.png` });
await page.locator('[data-button="single"]').click();
assert.equal(JSON.parse(await risky).hookSpecificOutput.decision.behavior, 'allow');
console.log('• high-risk: nod + button in Studio → allow ✓');

// Shake denies.
const denied = runHook({
  hook_event_name: 'PermissionRequest', session_id: 'studio-smoke-01', cwd: '/Users/me/memomind-plugins',
  tool_name: 'Write', tool_input: { file_path: '/Users/me/memomind-plugins/README.md' },
});
await frame.locator('.ask').first().filter({ hasText: 'README.md' }).waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
await gesture(page, 'shake');
assert.equal(JSON.parse(await denied).hookSpecificOutput.decision.behavior, 'deny');
console.log('• shake in Studio → deny ✓');

await page.waitForTimeout(1500);
await page.locator('#device-canvas').screenshot({ path: `${OUT}/hud-after.png` });
await page.screenshot({ path: `${OUT}/studio-full.png` });
await browser.close();
console.log(`Screenshots written to ${OUT}`);
