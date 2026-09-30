// End-to-end: throwaway git repo in the OS temp dir + real server + websocket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { applyHunk, stringModel } from '../public/replay.js';
import type { ChangeEvent } from '../src/server.ts';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let repo: string;
let proc: ChildProcess;
let base: string;
let ws: WebSocket;
const events: ChangeEvent[] = [];
const fileLists: { path: string; status: string }[][] = [];

const W = (p: string, t: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), t);
};
const R = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');
const A0 = 'const a = 1;\nconst b = 2;\n\nfunction f() {\n  return 1;\n}\n\nconst c = 3;\n// end\n';

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-e2e-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  g('init', '-q');
  W('.gitignore', 'ignored.log\nbuild/\n');
  W('a.js', A0);
  W('README.md', '# test\n');
  W('pre-dirty.txt', 'clean\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  W('pre-dirty.txt', 'dirty v1\n');
  W('staged.js', 'new\n'); // added to the index => "changed"
  g('add', 'staged.js');
  W('assets/img/logo.svg', '<svg/>'); // untracked directory => expanded to files
  W('assets/notes.txt', 'n');
  W('build/pre.js', 'ignored'); // git-ignored => hidden

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
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d));
    if (msg.type === 'change') events.push(msg);
    if (msg.type === 'files') fileLists.push(msg.files);
  });
  await new Promise((r) => ws.on('open', r));
});

after(() => {
  ws?.close();
  proc?.kill();
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

test('serves the page and static assets', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Coding Observatory/);
  assert.match(html, /monaco-editor/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/replay.js')).status, 200);
  assert.equal((await fetch(base + '/..%2fsrc%2fserver.ts')).status, 403);
});

test('initial file list contains the pre-dirty file', async () => {
  const api = await (await fetch(base + '/api/files')).json();
  assert.deepEqual(api.files, [
    { path: 'pre-dirty.txt', status: 'modified', category: 'changed' },
    { path: 'staged.js', status: 'added', category: 'changed' },
    { path: 'assets/img/logo.svg', status: 'untracked', category: 'untracked' },
    { path: 'assets/notes.txt', status: 'untracked', category: 'untracked' },
  ]);
});

test('edits stream as ordered, contiguous, replayable events', async () => {
  W(
    'a.js',
    A0.replace('const b = 2;', 'const b = 20;\nconst bb = 21;').replace('// end', '// the end'),
  );
  await sleep(200);
  W('a.js', R('a.js').replace('function f() {\n  return 1;\n}\n', ''));
  await sleep(200);
  W('a.js', 'export const first = true;\n' + R('a.js') + 'console.log("appended")');
  await sleep(200);
  W('pre-dirty.txt', 'dirty v2\n');
  W('b.ts', 'export type X = { a: number };\n');
  W('ignored.log', 'nope');
  W('build/out.js', 'nope');
  W('node_modules/x/i.js', 'nope');
  W('dist/d.js', 'nope');
  fs.unlinkSync(path.join(repo, 'README.md'));
  for (let i = 1; i <= 5; i++) {
    W('burst.txt', Array.from({ length: i }, (_, k) => `line ${k}`).join('\n') + '\n');
    await sleep(100);
  }
  await sleep(1500);

  const paths = events.map((e) => e.path);
  assert.ok(!paths.some((p) => /ignored\.log|build\/|node_modules|dist\//.test(p)), paths.join());
  assert.ok(events.every((e, i) => i === 0 || e.id > events[i - 1].id));

  const aEv = events.filter((e) => e.path === 'a.js');
  assert.equal(aEv.length, 3);
  assert.equal(aEv[0].before, A0, 'first event diffs from HEAD');
  const pd = events.find((e) => e.path === 'pre-dirty.txt');
  assert.equal(pd?.before, 'dirty v1\n', 'dirty-at-startup file diffs from startup snapshot');
  assert.ok(events.some((e) => e.path === 'b.ts' && e.status === 'created'));
  assert.ok(events.some((e) => e.path === 'README.md' && e.status === 'deleted'));

  for (const p of ['a.js', 'burst.txt']) {
    const evs = events.filter((e) => e.path === p);
    assert.ok(evs.length >= (p === 'burst.txt' ? 3 : 3), `${p}: ${evs.length} events`);
    evs.forEach((e, i) => i && assert.equal(e.before, evs[i - 1].after, `${p} contiguous`));
    assert.equal(evs.at(-1)!.after, R(p), `${p} final content matches disk`);
  }
  for (const e of events) {
    const m = stringModel(e.before);
    for (const h of e.hunks) applyHunk(m, h, 2);
    assert.equal(m.getValue(), e.after, `replay of #${e.id} ${e.path}`);
  }
});

test('file list is categorised (changed first, then untracked) over HTTP and websocket', async () => {
  const api = await (await fetch(base + '/api/files')).json();
  const summary = api.files.map(
    (f: { path: string; status: string; category: string; editedAt?: number }) => ({
      path: f.path,
      status: f.status,
      category: f.category,
      edited: typeof f.editedAt === 'number',
    }),
  );
  assert.deepEqual(summary, [
    { path: 'a.js', status: 'modified', category: 'changed', edited: true },
    { path: 'pre-dirty.txt', status: 'modified', category: 'changed', edited: true },
    { path: 'README.md', status: 'deleted', category: 'changed', edited: true },
    { path: 'staged.js', status: 'added', category: 'changed', edited: false },
    { path: 'assets/img/logo.svg', status: 'untracked', category: 'untracked', edited: false },
    { path: 'assets/notes.txt', status: 'untracked', category: 'untracked', edited: false },
    { path: 'b.ts', status: 'untracked', category: 'untracked', edited: true },
    { path: 'burst.txt', status: 'untracked', category: 'untracked', edited: true },
  ]);
  assert.deepEqual(fileLists.at(-1), api.files, 'websocket payload matches HTTP');
});

test('diff endpoint returns HEAD vs working copy', async () => {
  const d = await (await fetch(base + '/api/diff?path=a.js')).json();
  assert.equal(d.head, A0);
  assert.equal(d.current, R('a.js'));
  assert.equal((await fetch(base + '/api/diff?path=../../etc/passwd')).status, 400);
});

test('lock files and large edits are tagged instant; normal edits are not', async () => {
  const from = events.length;
  W('package-lock.json', '{\n  "lockfileVersion": 3\n}\n');
  await sleep(200);
  W(
    'big.js',
    Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n',
  );
  await sleep(200);
  W('small.js', 'export const s = 1;\n');
  await sleep(800);
  const tags = Object.fromEntries(events.slice(from).map((e) => [e.path, e.instant]));
  assert.deepEqual(tags, { 'package-lock.json': 'generated', 'big.js': 'large', 'small.js': null });
});
