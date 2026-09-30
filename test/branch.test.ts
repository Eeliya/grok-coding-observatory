// Branch switches / HEAD moves must reset baselines instead of replaying as typing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let repo: string;
let proc: ChildProcess;
let base: string;
let ws: WebSocket;
const messages: { type: string; [k: string]: any }[] = [];

const g = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
const W = (p: string, t: string) => fs.writeFileSync(path.join(repo, p), t);
const R = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');
const of = (type: string) => messages.filter((m) => m.type === type);
const api = async () => (await fetch(base + '/api/files')).json();

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-branch-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  W('a.js', 'const a = 1;\n');
  W('b.scss', '.b { color: red; }\n');
  g('add', '-A');
  g('commit', '-qm', 'main');
  g('checkout', '-qb', 'feature');
  W('a.js', 'const a = 1;\n' + 'export const feature = true;\n'.repeat(50));
  W('c.html', '<p>feature</p>\n');
  g('add', '-A');
  g('commit', '-qm', 'feature');
  g('checkout', '-q', 'main');

  proc = spawn(process.execPath, [SERVER, repo], { env: { ...process.env, PORT: '0' } });
  base = await new Promise<string>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/Open (http:\/\/\S+)/);
      if (m) resolve(m[1].replace('localhost', '127.0.0.1'));
    });
    proc.stderr!.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  await sleep(300);
});

after(() => {
  ws?.close();
  proc?.kill();
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

test('reports the current branch and short sha', async () => {
  const sha = g('rev-parse', '--short', 'HEAD');
  const expected = { branch: 'main', sha, detached: false };
  assert.deepEqual((await api()).head, expected);
  assert.deepEqual(of('hello')[0].head, expected);
});

test('branch switch resets instead of replaying the branch diff', async () => {
  g('checkout', '-q', 'feature');
  await sleep(2800);
  assert.equal(of('change').length, 0, 'no typing replay for checkout');
  const resets = of('reset');
  assert.equal(resets.length, 1);
  assert.equal(resets[0].reason, 'branch');
  assert.deepEqual(resets[0].head, {
    branch: 'feature',
    sha: g('rev-parse', '--short', 'HEAD'),
    detached: false,
  });
  assert.deepEqual(resets[0].files, []);
  assert.equal((await api()).head.branch, 'feature');

  // A real edit afterwards is diffed against the new branch's content.
  const featureA = R('a.js');
  W('a.js', featureA + '// edited on feature\n');
  await sleep(600);
  const changes = of('change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'a.js');
  assert.equal(changes[0].before, featureA);
  assert.equal(changes[0].hunks.length, 1);
});

test('commit moves HEAD: reset, file list cleared, no replay', async () => {
  g('commit', '-qam', 'edit');
  await sleep(2800);
  assert.equal(of('change').length, 1, 'still only the one real edit');
  const last = of('reset').at(-1)!;
  assert.equal(last.reason, 'head');
  assert.equal(last.head.sha, g('rev-parse', '--short', 'HEAD'));
  assert.deepEqual((await api()).files, []);
});

test('detached HEAD shows the sha', async () => {
  g('checkout', '-q', '--detach', 'main');
  await sleep(2800);
  assert.equal(of('change').length, 1, 'checkout to main did not replay');
  const { head, files } = await api();
  assert.deepEqual(head, { branch: null, sha: g('rev-parse', '--short', 'HEAD'), detached: true });
  assert.deepEqual(files, []);
});
