import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PANELS, STAGE_MIN, clampWidth, keyStep, panelBounds } from '../public/panel-size.js';

test('panel bounds keep the editor usable', () => {
  // 1280 wide: main inner ~1256 minus two 10px gaps.
  const b = panelBounds('timeline', 1236, 264);
  assert.equal(b.min, PANELS.timeline.min);
  assert.equal(b.max, 1236 - 264 - STAGE_MIN);
  // Lots of room: capped by the panel max.
  assert.equal(panelBounds('timeline', 3000, 264).max, PANELS.timeline.max);
  // No room at all: max never drops below min.
  assert.equal(panelBounds('side', 500, 400).max, PANELS.side.min);
});

test('clampWidth clamps and rejects junk', () => {
  const b = { min: 300, max: 600 };
  assert.equal(clampWidth(450.4, b), 450);
  assert.equal(clampWidth(100, b), 300);
  assert.equal(clampWidth('900', b), 600);
  assert.equal(clampWidth(null, b), null);
  assert.equal(clampWidth('abc', b), null);
});

test('arrow keys grow the panel away from the editor', () => {
  // Timeline handle sits on the panel's left edge: ← widens it.
  assert.equal(keyStep(400, 'ArrowLeft', false, 'left'), 416);
  assert.equal(keyStep(400, 'ArrowRight', true, 'left'), 336);
  // File list handle sits on its right edge: → widens it.
  assert.equal(keyStep(264, 'ArrowRight', false, 'right'), 280);
  assert.equal(keyStep(264, 'Enter', false, 'right'), null);
});
