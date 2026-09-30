import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks } from '../src/hunks.ts';
import { applyHunk, stringModel } from '../public/replay.js';

function replay(before: string, after: string, chunkSize: number) {
  const m = stringModel(before);
  for (const h of computeHunks(before, after)) {
    const lines = m.getValue().split('\n');
    assert.deepEqual(lines.slice(h.line - 1, h.line - 1 + h.removed.length), h.removed);
    applyHunk(m, h, chunkSize);
  }
  return m.getValue();
}

const cases: [string, string][] = [
  ['', ''],
  ['', 'a\nb\n'],
  ['a\nb\n', ''],
  ['a\nb\nc', 'a\nc'],
  ['a\nb\nc', 'a\nb'],
  ['a\nb\nc\n', 'x\na\nb\nc\ny\n'],
  ['a\nb\nc', 'a\nb\nc\n'],
  ['a\nb\nc\n', 'a\nb\nc'],
  ['one', 'two'],
  ['x\n', '\n'],
  ['  indent\n\tfoo\n', '    indent\n\t\tbar\n  baz'],
  ['emoji 😀\n', 'emoji 😀😀 ok\n'],
  ['a\r\nb\r\n', 'a\r\nc\r\n'],
];

test('replaying hunks reproduces the new content (fixed cases)', () => {
  for (const [before, after] of cases) {
    for (const chunk of [1, 3, Infinity]) assert.equal(replay(before, after, chunk), after);
  }
});

test('replaying hunks reproduces the new content (randomised)', () => {
  let seed = 42;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  const vocab = ['', 'a', 'b', 'foo()', '  x = 1;', '}', '\t// c', 'ü😀'];
  const gen = () => Array.from({ length: rnd(12) }, () => vocab[rnd(vocab.length)]).join('\n');
  for (let i = 0; i < 2000; i++) {
    const before = gen();
    const after = rnd(3) ? gen() : before + '\n' + gen();
    assert.equal(replay(before, after, 1 + rnd(5)), after, JSON.stringify({ before, after }));
  }
});
