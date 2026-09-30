import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks } from '../src/hunks.ts';
import {
  MAX_ANIMATED_CHARS,
  MAX_ANIMATED_LINES,
  QUEUE_INSTANT_AT,
  QUEUE_TURBO_AT,
  QUEUE_TURBO_FACTOR,
  changeSize,
  effectiveCps,
  instantReason,
  isGeneratedFile,
} from '../public/playback-policy.js';

test('lock / generated / minified files are recognised', () => {
  for (const p of [
    'package-lock.json',
    'apps/web/package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.lock',
    'Cargo.lock',
    'go.sum',
    'bun.lockb',
    'dist-ish/vendor.min.js',
    'styles/app.min.css',
    'assets/app.js.map',
    '__snapshots__/x.test.ts.snap',
  ]) {
    assert.ok(isGeneratedFile(p), p);
  }
  for (const p of ['package.json', 'src/app.js', 'lockscreen.ts', 'src/minify.js', 'map.ts']) {
    assert.ok(!isGeneratedFile(p), p);
  }
});

test('change size counts removed + added lines and characters', () => {
  const hunks = computeHunks('a\nbb\nc\n', 'a\nXYZ\nc\nd\n');
  assert.deepEqual(changeSize(hunks), { lines: 3, chars: 3 + 4 + 2 });
});

test('instantReason: generated files, big edits, normal edits', () => {
  const small = computeHunks('a\n', 'a\nb\n');
  assert.equal(instantReason('src/app.js', small), null);
  assert.equal(instantReason('package-lock.json', small), 'generated');

  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  assert.equal(instantReason('src/a.js', computeHunks('', lines(MAX_ANIMATED_LINES - 1))), null);
  assert.equal(instantReason('src/a.js', computeHunks('', lines(MAX_ANIMATED_LINES + 5))), 'large');

  const longLine = 'x'.repeat(MAX_ANIMATED_CHARS + 10);
  assert.equal(instantReason('src/a.js', computeHunks('', longLine)), 'large');
});

test('queue backlog fast-forwards playback', () => {
  assert.equal(effectiveCps(700, 0), 700);
  assert.equal(effectiveCps(700, QUEUE_TURBO_AT - 1), 700);
  assert.equal(effectiveCps(700, QUEUE_TURBO_AT), 700 * QUEUE_TURBO_FACTOR);
  assert.equal(effectiveCps(700, QUEUE_INSTANT_AT), Infinity);
  assert.equal(effectiveCps(Infinity, 0), Infinity);
});
