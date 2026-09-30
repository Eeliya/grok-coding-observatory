// Commit browser endpoints: first-parent history, commit detail and per-file playback events.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
let tmp: string;
let repo: string;
let proc: ChildProcess;
let base: string;
const shas: Record<string, string> = {};

const get = async (p: string) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-commits-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo }).toString().trim();
  const W = (p: string, t: string | Buffer) => fs.writeFileSync(path.join(repo, p), t);
  const commit = (name: string, msg: string) => {
    g('add', '-A');
    g('commit', '-qm', msg);
    shas[name] = g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'ada@example.com');
  g('config', 'user.name', 'Ada');
  W('a.js', 'one\ntwo\n');
  W('logo.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
  commit('root', 'Initial commit');
  W('a.js', 'one\n2\nthree\n');
  W('b.js', 'bee\n');
  commit('second', 'Edit a, add b');
  g('checkout', '-qb', 'feature');
  W('c.js', 'feature\n');
  commit('featureOnly', 'Feature work');
  g('checkout', '-q', 'main');
  W('d.js', 'main side\n');
  commit('mainSide', 'Main side');
  g('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
  shas.merge = g('rev-parse', 'HEAD');
  g('mv', 'b.js', 'bee.js');
  fs.rmSync(path.join(repo, 'd.js'));
  commit('rename', 'Rename b, delete d');
  W(
    'big.js',
    Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n',
  );
  W('package-lock.json', '{\n  "lockfileVersion": 3\n}\n');
  commit('big', 'Big commit');

  proc = spawn(process.execPath, [SERVER, repo], {
    env: { ...process.env, PORT: '0', OBSERVATORY_CONFIG_DIR: path.join(tmp, 'config') },
  });
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
});

after(() => {
  proc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('lists first-parent history of HEAD, newest first', async () => {
  const { status, body } = await get('/api/commits');
  assert.equal(status, 200);
  assert.deepEqual(
    body.commits.map((c: { subject: string }) => c.subject),
    [
      'Big commit',
      'Rename b, delete d',
      'Merge feature',
      'Main side',
      'Edit a, add b',
      'Initial commit',
    ],
  );
  assert.equal(body.more, false);
  const [top] = body.commits;
  assert.equal(top.sha, shas.big);
  assert.equal(top.short, shas.big.slice(0, top.short.length));
  assert.equal(top.author, 'Ada');
  assert.ok(Math.abs(top.date - Date.now()) < 120_000);
  assert.equal(body.head.branch, 'main');
});

test('pages with limit and before', async () => {
  const p1 = await get('/api/commits?limit=2');
  assert.equal(p1.body.commits.length, 2);
  assert.equal(p1.body.more, true);
  const p2 = await get(`/api/commits?limit=2&before=${p1.body.commits[1].short}`);
  assert.deepEqual(
    p2.body.commits.map((c: { sha: string }) => c.sha),
    [shas.merge, shas.mainSide],
  );
  const end = await get(`/api/commits?before=${shas.root}`);
  assert.deepEqual(end.body, { head: end.body.head, commits: [], more: false });
});

test('rejects invalid shas and 404s unknown ones', async () => {
  for (const bad of ['HEAD', 'main', 'abc', '..%2F..', 'zzzzzzz', 'a'.repeat(65)]) {
    assert.equal((await get(`/api/commit/${bad}`)).status, 400, bad);
    assert.equal((await get(`/api/commits?before=${bad}`)).status, 400, bad);
  }
  assert.equal((await get('/api/commit/deadbeefdeadbeef')).status, 404);
  assert.equal((await get('/api/commits?before=deadbeefdeadbeef')).status, 404);
  const blob = execFileSync('git', ['rev-parse', 'HEAD:a.js'], { cwd: repo }).toString().trim();
  assert.equal((await get(`/api/commit/${blob}`)).status, 404, 'a blob is not a commit');
});

test('root commit: every file added, binary flagged', async () => {
  const { body } = await get(`/api/commit/${shas.root.slice(0, 8)}`);
  assert.equal(body.sha, shas.root);
  assert.equal(body.base, null);
  assert.equal(body.subject, 'Initial commit');
  assert.deepEqual(body.files, [
    { path: 'a.js', status: 'added', binary: false, plus: 2, minus: 0 },
    { path: 'logo.bin', status: 'added', binary: true, plus: 0, minus: 0 },
  ]);
  const a = (await get(`/api/commit/${shas.root}/file?path=a.js`)).body;
  assert.equal(a.status, 'created');
  assert.equal(a.before, '');
  assert.equal(a.after, 'one\ntwo\n');
  const bin = (await get(`/api/commit/${shas.root}/file?path=logo.bin`)).body;
  assert.equal(bin.binary, true);
  assert.equal(bin.instant, 'binary');
  assert.deepEqual(bin.hunks, []);
});

test('regular commit: parent → commit diff per file', async () => {
  const { body } = await get(`/api/commit/${shas.second}`);
  assert.equal(body.base, shas.root);
  assert.deepEqual(
    body.files.map((f: { path: string; status: string; plus: number; minus: number }) => [
      f.path,
      f.status,
      f.plus,
      f.minus,
    ]),
    [
      ['a.js', 'modified', 2, 1],
      ['b.js', 'added', 1, 0],
    ],
  );
  const ev = (await get(`/api/commit/${shas.second}/file?path=a.js`)).body;
  assert.equal(ev.before, 'one\ntwo\n');
  assert.equal(ev.after, 'one\n2\nthree\n');
  assert.equal(ev.instant, null);
  assert.deepEqual(ev.hunks, [{ line: 2, removed: ['two'], added: ['2', 'three'] }]);
});

test('merge commit: diff against the first parent only', async () => {
  const { body } = await get(`/api/commit/${shas.merge}`);
  assert.equal(body.parents.length, 2);
  assert.equal(body.base, shas.mainSide);
  assert.deepEqual(
    body.files.map((f: { path: string }) => f.path),
    ['c.js'],
  );
});

test('renames, deletes and the instant policy', async () => {
  const r = (await get(`/api/commit/${shas.rename}`)).body;
  assert.deepEqual(
    r.files.map((f: { path: string; oldPath?: string; status: string }) => [
      f.path,
      f.oldPath,
      f.status,
    ]),
    [
      ['bee.js', 'b.js', 'renamed'],
      ['d.js', undefined, 'deleted'],
    ],
  );
  const renamed = (await get(`/api/commit/${shas.rename}/file?path=bee.js`)).body;
  assert.equal(renamed.before, 'bee\n');
  assert.equal(renamed.after, 'bee\n');
  const del = (await get(`/api/commit/${shas.rename}/file?path=d.js`)).body;
  assert.equal(del.status, 'deleted');
  assert.equal(del.after, '');
  const big = (await get(`/api/commit/${shas.big}/file?path=big.js`)).body;
  assert.equal(big.instant, 'large');
  const lock = (await get(`/api/commit/${shas.big}/file?path=package-lock.json`)).body;
  assert.equal(lock.instant, 'generated');
});

test('file endpoint validates the path', async () => {
  assert.equal((await get(`/api/commit/${shas.big}/file?path=a.js`)).status, 404);
  assert.equal((await get(`/api/commit/${shas.big}/file?path=../x`)).status, 400);
  assert.equal((await get(`/api/commit/${shas.big}/file`)).status, 400);
});
