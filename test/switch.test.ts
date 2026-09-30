// Switching the watched repo live via the API, recent/last-used persistence and discovery.
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
let tmp: string;
let work: string;
let config: string;
let repoA: string;
let repoB: string;
let repoC: string;
let proc: ChildProcess | undefined;
let ws: WebSocket | undefined;
let base: string;
let messages: { type: string; [k: string]: any }[] = [];

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'main');
  for (const [p, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), t);
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
}

async function startServer(args: string[] = []) {
  messages = [];
  proc = spawn(process.execPath, [SERVER, ...args], {
    env: {
      ...process.env,
      PORT: '0',
      OBSERVATORY_CONFIG_DIR: config,
      REPOS_ROOT: work,
      TARGET_DIR: '',
    },
  });
  base = await new Promise<string>((resolve, reject) => {
    let out = '';
    proc!.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/Open (http:\/\/\S+)/);
      if (m) resolve(m[1].replace('localhost', '127.0.0.1'));
    });
    proc!.stderr!.on('data', (d) => process.stderr.write(d));
    proc!.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise((r) => ws!.on('open', r));
  await sleep(200);
}

async function stopServer() {
  ws?.close();
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc!.once('exit', r));
    proc.kill();
    await exited;
  }
}

const post = (body: unknown, type = 'application/json') =>
  fetch(base + '/api/target', {
    method: 'POST',
    headers: { 'content-type': type },
    body: JSON.stringify(body),
  });
const of = (type: string) => messages.filter((m) => m.type === type);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-switch-'));
  work = path.join(tmp, 'work');
  config = path.join(tmp, 'config');
  repoA = path.join(work, 'alpha');
  repoB = path.join(work, 'beta');
  repoC = path.join(work, 'org', 'gamma'); // two levels deep: found
  makeRepo(repoA, { 'a.js': 'const a = 1;\n' });
  makeRepo(repoB, { 'b.scss': '.b { color: red; }\n' });
  makeRepo(repoC, { 'c.html': '<p>c</p>\n' });
  makeRepo(path.join(work, 'x', 'y', 'too-deep'), { 'd.txt': 'd\n' });
  fs.mkdirSync(path.join(work, 'plain-folder'));
  fs.writeFileSync(path.join(repoB, 'b.scss'), '.b { color: blue; }\n'); // dirty
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('starts without a repo when no argument and nothing remembered', async () => {
  await startServer();
  const files = await (await fetch(base + '/api/files')).json();
  assert.equal(files.target, null);
  assert.deepEqual(files.files, []);
  assert.equal(of('hello')[0].target, null);
  assert.equal((await fetch(base + '/api/diff?path=a.js')).status, 409);
});

test('discovers git repos under REPOS_ROOT two levels deep', async () => {
  const repos = await (await fetch(base + '/api/repos')).json();
  assert.equal(repos.scanRoot, work);
  assert.deepEqual(
    repos.found.map((r: { name: string; branch: string }) => [r.name, r.branch]),
    [
      ['alpha', 'main'],
      ['beta', 'main'],
      [path.join('org', 'gamma'), 'main'],
    ],
  );
  assert.deepEqual(repos.recent, []);
  assert.equal(repos.current, null);
});

test('rejects invalid targets and non-JSON requests', async () => {
  assert.equal((await post({ path: repoA }, 'text/plain')).status, 415);
  for (const [p, msg] of [
    [path.join(work, 'plain-folder'), /Not a git work tree/],
    [path.join(work, 'missing'), /does not exist/],
    ['relative/path', /absolute path/],
    ['', /Enter a folder path/],
  ] as const) {
    const res = await post({ path: p });
    assert.equal(res.status, 400, p);
    assert.match((await res.json()).error, msg);
  }
  assert.equal(of('reset').length, 0);
});

test('switches repos live: reset broadcast, old watcher stopped, new one active', async () => {
  let res = await post({ path: repoA });
  assert.equal(res.status, 200);
  let reset = of('reset').at(-1)!;
  assert.equal(reset.reason, 'repo');
  assert.equal(reset.target, repoA);
  assert.equal(reset.head.branch, 'main');
  fs.writeFileSync(path.join(repoA, 'a.js'), 'const a = 2;\n');
  await sleep(600);
  assert.deepEqual(
    of('change').map((c) => c.path),
    ['a.js'],
  );

  res = await post({ path: repoB });
  assert.equal(res.status, 200);
  reset = of('reset').at(-1)!;
  assert.equal(reset.target, repoB);
  assert.deepEqual(
    reset.files.map(({ hash: _h, ...f }: { hash?: string }) => f),
    [{ path: 'b.scss', status: 'modified', category: 'changed' }],
  );
  const info = await (await fetch(base + '/api/files')).json();
  assert.equal(info.target, repoB);

  fs.writeFileSync(path.join(repoA, 'a.js'), 'const a = 3;\n'); // old repo: ignored now
  fs.writeFileSync(path.join(repoB, 'b.scss'), '.b { color: green; }\n');
  await sleep(700);
  const changes = of('change');
  assert.deepEqual(
    changes.map((c) => c.path),
    ['a.js', 'b.scss'],
  );
  assert.equal(
    changes[1].before,
    '.b { color: blue; }\n',
    'dirty file starts from current content',
  );
  assert.ok(changes[1].id > changes[0].id, 'event ids keep increasing across repos');

  const repos = await (await fetch(base + '/api/repos')).json();
  assert.equal(repos.current, repoB);
  assert.deepEqual(
    repos.recent.map((r: { path: string }) => r.path),
    [repoB, repoA],
  );
});

test('a failed switch keeps watching the current repo', async () => {
  const res = await post({ path: path.join(work, 'plain-folder') });
  assert.equal(res.status, 400);
  assert.equal((await (await fetch(base + '/api/files')).json()).target, repoB);
});

test('remembers the last used repo across restarts (no CLI argument)', async () => {
  await stopServer();
  const state = JSON.parse(fs.readFileSync(path.join(config, 'state.json'), 'utf8'));
  assert.equal(state.lastRepo, repoB);
  await startServer();
  assert.equal(of('hello')[0].target, repoB);
});

test('a CLI argument overrides the remembered repo', async () => {
  await stopServer();
  await startServer([repoC]);
  assert.equal(of('hello')[0].target, repoC);
  const state = JSON.parse(fs.readFileSync(path.join(config, 'state.json'), 'utf8'));
  assert.equal(state.lastRepo, repoC);
});
