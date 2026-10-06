// Module hook used by observatory.mjs: loads this package's src/*.ts by stripping the types with
// amaro (Node's own type stripper), which also works under node_modules and on every Node >= 22.6.
import fs from 'node:fs/promises';
import { transformSync } from 'amaro';

let root = '';

export function initialize(data) {
  root = data.root;
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith(root) || !url.endsWith('.ts')) return nextLoad(url, context);
  const source = await fs.readFile(new URL(url), 'utf8');
  const { code } = transformSync(source, { mode: 'strip-only' });
  return { format: 'module', source: code, shortCircuit: true };
}
