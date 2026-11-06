import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'));
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  assert.ok(manifest[key], `Missing manifest entry: ${key}`);
  initial.add(key);
  (manifest[key].imports || []).forEach(visit);
}
visit('index.html');
const globe = Object.keys(manifest).find((key) => key.endsWith('/server-globe.vue'));
assert.ok(globe, 'Expected a lazy globe component');
assert.equal(initial.has(globe), false, 'The globe must not be part of the initial static graph');
const initialCss = [...initial].flatMap((key) => manifest[key].css || [])
  .map((file) => readFileSync(new URL(file, dist), 'utf8')).join('\n');
assert.doesNotMatch(initialCss, /@font-face\s*\{[^}]*Sarasa/s, 'Sarasa must load only after opt-in');
const jsBytes = [...initial].reduce((sum, key) => sum + statSync(new URL(manifest[key].file, dist)).size, 0);
console.log(`Initial static JS: ${(jsBytes / 1024).toFixed(1)} KiB; globe and Sarasa excluded.`);
