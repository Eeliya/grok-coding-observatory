// Session timeline: edits + HEAD markers kept server-side, cleared on repo switch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');
let tmp: string;
let repoA: string;
let repoB: string;
let proc: ChildProcess;
let ws: WebSocket;
let base: string;
const messages: { type: string; [k: string]: any }[] = [];

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  for (const [p, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), t);
  g('add', '-A');
  g('commit', '-qm', 'init');
}
const history = async () => (await (await fetch(base + '/api/history')).json()).items;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-history-'));
  repoA = path.join(tmp, 'a');
  repoB = path.join(tmp, 'b');
  makeRepo(repoA, { 'a.js': 'one\ntwo\nthree\n' });
  makeRepo(repoB, { 'b.js': 'b\n' });
  proc = spawn(process.execPath, [SERVER, repoA], {
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
  ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
});

after(() => {
  ws?.close();
  proc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('edits are recorded with a compact summary and fetchable in full', async () => {
  assert.deepEqual(await history(), []);
  fs.writeFileSync(path.join(repoA, 'a.js'), 'one\nTWO\nthree\nfour\n');
  await sleep(500);
  fs.writeFileSync(path.join(repoA, 'new.css'), '.x {}\n');
  await sleep(500);
  const items = await history();
  assert.deepEqual(
    items.map((i: any) => [i.type, i.path, i.status, i.plus, i.minus]),
    [
      ['edit', 'a.js', 'modified', 2, 1],
      ['edit', 'new.css', 'created', 1, 0],
    ],
  );
  const full = await (await fetch(`${base}/api/history/${items[0].id}`)).json();
  assert.equal(full.before, 'one\ntwo\nthree\n');
  assert.equal(full.after, 'one\nTWO\nthree\nfour\n');
  assert.equal(full.hash, sha1(full.after), 'event carries the content hash of `after`');
  assert.equal((await fetch(`${base}/api/history/999999`)).status, 404);
  const diff = await (await fetch(`${base}/api/diff?path=a.js`)).json();
  assert.equal(diff.currentHash, full.hash);
});

test('commit and branch switch add markers instead of wiping the timeline', async () => {
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repoA });
  g('add', '-A');
  g('commit', '-qm', 'wip');
  await sleep(2600);
  g('checkout', '-qb', 'feature');
  await sleep(2600);
  const items = await history();
  assert.deepEqual(
    items.map((i: any) => (i.type === 'marker' ? `${i.reason}:${i.head.branch}` : i.path)),
    ['a.js', 'new.css', 'head:main', 'branch:feature'],
  );
  const resets = messages.filter((m) => m.type === 'reset');
  assert.equal(resets.at(-1)!.marker.reason, 'branch', 'reset message carries the marker');
});

test('new websocket clients receive the history', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  await sleep(200);
  ws.close();
  const h = got.find((m) => m.type === 'history');
  assert.equal(h.items.length, 4);
});

test('switching repos clears the timeline', async () => {
  const res = await fetch(base + '/api/target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoB }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await history(), []);
});
