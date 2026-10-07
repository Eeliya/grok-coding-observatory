// Always-ignored path segments (node_modules, .git, dist, observatory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlwaysIgnored } from '../src/session.ts';

test('isAlwaysIgnored hides protocol and tooling directories', () => {
  assert.equal(isAlwaysIgnored('observatory/status/grok.json'), true);
  assert.equal(isAlwaysIgnored('observatory/logs/run.txt'), true);
  assert.equal(isAlwaysIgnored('src/observatory/util.ts'), true); // any segment named observatory
  assert.equal(isAlwaysIgnored('.git/observatory/status/grok.json'), true);
  assert.equal(isAlwaysIgnored('node_modules/x/i.js'), true);
  assert.equal(isAlwaysIgnored('dist/d.js'), true);
  assert.equal(isAlwaysIgnored('src/session.ts'), false);
  assert.equal(isAlwaysIgnored('docs/AGENT-PROTOCOL.md'), false);
});
