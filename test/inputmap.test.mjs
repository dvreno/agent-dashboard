import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Limits from the official reference (reference/hogp-inputmap).
const MAX_BYTES = 8192;
const MAX_USAGE_KEY = 16;
const MAX_VALUE_MATCH = 4;
const MAX_VALUES = 6;
const KEYS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 54, 55, 56, 57, 58, 65535]);
// Outputs that never become a GMP button event (MENU, media, volume).
const NOT_FOR_GMP = new Set([7, 8, 9, 10, 11, 12, 13]);

const dir = new URL('../inputmap/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

test('inputmap files exist', () => assert.ok(files.length >= 2));

for (const name of files) {
  test(`inputmap ${name} fits the App's limits and only uses keys the plugin receives`, () => {
    const bytes = readFileSync(new URL(name, dir));
    assert.ok(bytes.length <= MAX_BYTES, 'at most 8192 bytes');
    const map = JSON.parse(bytes.toString('utf8'));
    assert.equal(map.version, 1);
    assert.ok(Array.isArray(map.rules) && map.rules.length > 0, 'import rejects an empty table');
    const usageKeys = map.rules.filter((rule) => rule.type === 'usage_key');
    const valueMatches = map.rules.filter((rule) => rule.type === 'value_match');
    assert.equal(usageKeys.length + valueMatches.length, map.rules.length, 'only usage_key and value_match');
    assert.ok(usageKeys.length <= MAX_USAGE_KEY);
    assert.ok(valueMatches.length <= MAX_VALUE_MATCH);
    const seen = new Set();
    const checkKey = (key) => {
      assert.ok(Number.isInteger(key) && KEYS.has(key), `key ${key} is importable`);
      assert.ok(!NOT_FOR_GMP.has(key), `key ${key} never reaches a GMP`);
    };
    for (const rule of map.rules) {
      for (const field of ['page', 'usage']) assert.ok(Number.isInteger(rule[field]) && rule[field] >= 0 && rule[field] <= 65535);
      const id = `${rule.page}:${rule.usage}:${rule.application ?? 0}:${rule.rid ?? 0}`;
      assert.ok(!seen.has(id), `duplicate rule ${id}`);
      seen.add(id);
      if (rule.type === 'usage_key') checkKey(rule.key);
      else {
        assert.ok(rule.values.length > 0 && rule.values.length <= MAX_VALUES);
        for (const entry of rule.values) checkKey(entry.key);
      }
    }
  });
}
