// Agent status protocol: file parsing, staleness, the folder watcher, the HTTP API and the CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  StatusWatcher,
  isLoopback,
  isStale,
  parseStatus,
  statusDir,
  writeStatus,
  decodeStatusFile,
  type StatusLogEntry,
} from '../src/status.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.ts');
const CLI = path.join(ROOT, 'bin', 'status.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tmp: string;
let repo: string;
let proc: ChildProcess | undefined;
let ws: WebSocket | undefined;
let base: string;
let messages: { type: string; [k: string]: any }[] = [];

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
}

/** Poll `fn` until it returns a truthy value (the watcher polls once per second). */
async function until<T>(fn: () => T, what: string, ms = 6000): Promise<NonNullable<T>> {
  for (let t = 0; t < ms; t += 50) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-status-'));
  repo = path.join(tmp, 'repo');
  makeRepo(repo);
  proc = spawn(process.execPath, [SERVER, repo], {
    env: {
      ...process.env,
      PORT: '0',
      OBSERVATORY_CONFIG_DIR: path.join(tmp, 'config'),
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
});

after(async () => {
  ws?.close();
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc!.once('exit', r));
    proc.kill();
    await exited;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lastStatus = (): any => messages.filter((m) => m.type === 'status').at(-1);
const agentIn = (m: any, name: string) => m?.agents?.find((a: any) => a.agent === name);

test('parseStatus: full, minimal, BOM, epoch seconds and sanitizing', () => {
  const full = parseStatus(
    '{"state":"working","message":"Running lint","agent":"grok","ts":"2026-09-30T10:00:00Z","ttl":120}',
    'x',
    1,
  );
  assert.deepEqual(full, {
    agent: 'grok',
    state: 'working',
    message: 'Running lint',
    ts: Date.parse('2026-09-30T10:00:00Z'),
    ttl: 120,
  });
  const min = parseStatus('{"state":"DONE"}', 'claude', 12345);
  assert.deepEqual(min, { agent: 'claude', state: 'done', message: '', ts: 12345, ttl: 600 });
  assert.equal(parseStatus('\uFEFF{"state":"idle"}', 'a', 1).state, 'idle');
  assert.equal(parseStatus('{"state":"idle","ts":1790000000}', 'a', 1).ts, 1790000000000);
  assert.equal(parseStatus('{"state":"idle","ts":"nonsense"}', 'a', 77).ts, 77);
  assert.equal(parseStatus('{"state":"idle","agent":"my agent/1"}', 'a', 1).agent, 'my-agent-1');
  assert.equal(
    parseStatus(`{"state":"done","message":"${'x'.repeat(500)}"}`, 'a', 1).message.length,
    200,
  );
  assert.equal(parseStatus('{"state":"working","ttl":-5}', 'a', 1).ttl, 600);
});

test('parseStatus rejects malformed files with a readable reason', () => {
  assert.throws(() => parseStatus('{"state":"working"', 'a', 1), /not valid JSON/);
  assert.throws(() => parseStatus('', 'a', 1), /not valid JSON/);
  assert.throws(() => parseStatus('[1,2]', 'a', 1), /not a JSON object/);
  assert.throws(() => parseStatus('{"state":"busy"}', 'a', 1), /must be one of/);
  assert.throws(() => parseStatus('{"message":"no state"}', 'a', 1), /must be one of/);
});

test('a working status goes stale after its TTL; done and idle never do', () => {
  const now = Date.now();
  const s = { agent: 'a', state: 'working' as const, message: '', ts: now - 61_000, ttl: 60 };
  assert.equal(isStale(s, now), true);
  assert.equal(isStale({ ...s, ts: now - 59_000 }, now), false);
  assert.equal(isStale({ ...s, ttl: 600 }, now), false);
  assert.equal(isStale({ ...s, state: 'done' }, now), false);
  assert.equal(isStale({ ...s, state: 'idle' }, now), false);
});

test('isLoopback only accepts this machine', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.1.5', '::ffff:10.0.0.2', '172.17.0.1', undefined])
    assert.equal(isLoopback(a), false, String(a));
});

test('statusDir lives in the git dir, per worktree', async () => {
  const dir = await statusDir(repo);
  assert.equal(dir, path.join(fs.realpathSync(repo), '.git', 'observatory', 'status'));
  const wt = path.join(tmp, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: repo });
  const wtDir = await statusDir(wt);
  assert.match(wtDir, /[\\/]\.git[\\/]worktrees[\\/]wt[\\/]observatory[\\/]status$/);
  // Never shows up as a change in the work tree.
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, 'a.json'), '{"state":"done"}');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }), '');
});

test('StatusWatcher: multiple agents, malformed files keep the last good status', async () => {
  const dir = path.join(tmp, 'watch-dir');
  const events: StatusLogEntry[][] = [];
  const w = new StatusWatcher(dir, (_w, t) => events.push(t));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'early.json'), '{"state":"done","message":"before start"}');
  await w.start();
  try {
    assert.deepEqual(
      w.agents().map((a) => [a.agent, a.state]),
      [['early', 'done']],
    );
    assert.equal(w.log.length, 0, 'the baseline is not logged as activity');
    fs.writeFileSync(path.join(dir, 'a.json'), '{"state":"working","message":"Running lint"}');
    fs.writeFileSync(path.join(dir, 'b.json'), '{"state":"working","agent":"bee"}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    await until(() => w.agents().length === 3, 'three agents');
    assert.deepEqual(
      w.agents().map((a) => a.agent),
      ['a', 'bee', 'early'],
    );
    await until(() => events.flat().length >= 2, 'transitions');
    fs.writeFileSync(path.join(dir, 'a.json'), '{"state": "done", "mess');
    await until(() => w.problems().length === 1, 'a problem');
    assert.equal(w.problems()[0].file, 'a.json');
    assert.match(w.problems()[0].error, /not valid JSON/);
    assert.equal(w.agents().find((a) => a.agent === 'a')?.state, 'working', 'last good kept');
    fs.writeFileSync(path.join(dir, 'a.json'), '{"state":"done","message":"Lint clean"}');
    await until(() => w.agents().find((a) => a.agent === 'a')?.state === 'done', 'recovery');
    assert.equal(w.problems().length, 0);
    assert.deepEqual(w.log.at(-1), {
      agent: 'a',
      state: 'done',
      message: 'Lint clean',
      ts: w.agents().find((a) => a.agent === 'a')!.ts,
    });
    fs.rmSync(path.join(dir, 'b.json'));
    await until(() => w.agents().length === 2, 'removed agent disappears');
    assert.equal(w.snapshot().agents.length, 2);
  } finally {
    w.close();
  }
});

test('server: echo into the status folder reaches clients, with timeline markers', async () => {
  const initial = messages.find((m) => m.type === 'status');
  assert.ok(initial, 'status sent on connect');
  assert.deepEqual(initial.agents, []);
  const dir = await statusDir(repo);
  assert.ok(fs.existsSync(dir), 'the server creates the folder so plain echo works');
  fs.writeFileSync(
    path.join(dir, 'grok.json'),
    '{"state":"working","message":"Running tests","agent":"grok"}\n',
  );
  const m = await until(() => agentIn(lastStatus(), 'grok'), 'grok working');
  assert.equal(m.state, 'working');
  assert.equal(m.message, 'Running tests');
  assert.equal(m.stale, false);
  const marker = await until(
    () => messages.find((x) => x.type === 'marker' && x.marker.agent === 'grok'),
    'marker',
  );
  assert.equal(marker.marker.reason, 'agent');
  assert.equal(marker.marker.state, 'working');

  // A second agent is shown alongside; a stale one is flagged.
  const old = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(
    path.join(dir, 'other.json'),
    JSON.stringify({ state: 'working', message: 'Long build', ts: old, ttl: 60 }),
  );
  const other = await until(() => agentIn(lastStatus(), 'other'), 'other agent');
  assert.equal(other.stale, true);
  assert.ok(agentIn(lastStatus(), 'grok'), 'both agents listed');

  // Malformed file: reported as a problem, nothing crashes, the last good status stays.
  fs.writeFileSync(path.join(dir, 'grok.json'), 'not json at all');
  await until(() => lastStatus()?.problems?.length === 1, 'problem broadcast');
  assert.equal(agentIn(lastStatus(), 'grok').state, 'working');
  const snap = await (await fetch(base + '/api/status')).json();
  assert.equal(snap.problems[0].file, 'grok.json');
  assert.equal(snap.dir, dir);

  fs.writeFileSync(path.join(dir, 'grok.json'), '{"state":"done","message":"All green"}');
  await until(() => agentIn(lastStatus(), 'grok')?.state === 'done', 'grok done');
  assert.equal(lastStatus().problems.length, 0);
  const history = await (await fetch(base + '/api/history')).json();
  const states = history.items
    .filter((i: any) => i.reason === 'agent' && i.agent === 'grok')
    .map((i: any) => i.state);
  assert.deepEqual(states, ['working', 'done']);
  fs.rmSync(path.join(dir, 'other.json'));
});

test('POST /api/status: JSON only, validated, written to the status folder', async () => {
  const send = (body: string, type = 'application/json') =>
    fetch(base + '/api/status', { method: 'POST', headers: { 'content-type': type }, body });
  const form = await send('state=working', 'application/x-www-form-urlencoded');
  assert.equal(form.status, 415);
  const plain = await send('{"state":"working"}', 'text/plain');
  assert.equal(plain.status, 415);
  assert.equal((await send('{"state":"busy"}')).status, 400);
  assert.equal((await send('{"state":"done","agent":"../evil"}')).status, 400);
  assert.equal((await send('{"state":"done","ttl":"soon"}')).status, 400);
  assert.equal((await send('{nope')).status, 400);
  assert.equal((await fetch(base + '/api/status', { method: 'DELETE' })).status, 405);

  const ok = await send(
    JSON.stringify({ state: 'working', message: 'Via HTTP', agent: 'http', ttl: 30 }),
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.status.state, 'working');
  const file = path.join(await statusDir(repo), 'http.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, 'Via HTTP');
  const a = await until(() => agentIn(lastStatus(), 'http'), 'http agent broadcast');
  assert.equal(a.ttl, 30);
  // Missing agent defaults to "agent".
  assert.equal((await send('{"state":"idle"}')).status, 200);
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'agent.json')));
});

test('writeStatus and the CLI write the documented file', async () => {
  const dir = path.join(tmp, 'cli-status');
  await writeStatus(dir, { state: 'done', agent: 'w', message: 'ok' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'w.json'), 'utf8')).state, 'done');
  await assert.rejects(writeStatus(dir, { state: 'nah' }), /must be one of/);

  execFileSync(
    process.execPath,
    [CLI, 'status', 'working', 'Running', 'lint', '--agent', 'cli', '--ttl', '90'],
    {
      cwd: repo,
    },
  );
  const file = path.join(await statusDir(repo), 'cli.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.state, 'working');
  assert.equal(s.message, 'Running lint');
  assert.equal(s.ttl, 90);
  assert.ok(Date.now() - Date.parse(s.ts) < 10_000);
  const c = await until(() => agentIn(lastStatus(), 'cli'), 'cli agent broadcast');
  assert.equal(c.message, 'Running lint');
  execFileSync(process.execPath, [CLI, 'done', '--agent=cli', '--repo', repo], { cwd: tmp });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'done');
  assert.throws(() => execFileSync(process.execPath, [CLI, 'busy'], { cwd: repo, stdio: 'pipe' }));
});

test('decodeStatusFile: UTF-8 (BOM or not) and UTF-16 from Windows PowerShell 5', () => {
  const json = '{"state":"done","message":"héllo"}';
  assert.equal(decodeStatusFile(Buffer.from(json)), json);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json + '\r\n', 'utf16le')]);
  assert.equal(parseStatus(decodeStatusFile(le), 'ps', 1).message, 'héllo');
  const be = Buffer.from(Buffer.from(json, 'utf16le')).swap16();
  assert.equal(decodeStatusFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), json);
  assert.equal(decodeStatusFile(Buffer.from(json, 'utf16le')), json, 'UTF-16LE without BOM');
  const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]);
  assert.equal(parseStatus(decodeStatusFile(bom8), 'x', 1).state, 'done');
  const multi = JSON.stringify({ state: 'working', message: 'a\n  b\tc ' });
  assert.equal(parseStatus(multi, 'x', 1).message, 'a b c');
});

test('StatusWatcher: atomic renames, dotfile temps, half-written files and deletes', async () => {
  const dir = path.join(tmp, 'watch-real');
  fs.mkdirSync(dir, { recursive: true });
  const w = new StatusWatcher(dir, () => {});
  await w.start();
  let sawProblem = false;
  const spy = setInterval(() => (sawProblem ||= w.problems().length > 0), 20);
  try {
    // write a temp file, then mv over the target (what careful agents do)
    fs.writeFileSync(path.join(dir, '.grok.json'), '{"state":"working","message":"tmp"}');
    fs.writeFileSync(path.join(dir, 'grok.json.tmp'), '{"state":"working","message":"step 1"}');
    fs.renameSync(path.join(dir, 'grok.json.tmp'), path.join(dir, 'grok.json'));
    await until(() => w.agents().find((a) => a.agent === 'grok')?.message === 'step 1', 'rename 1');
    assert.deepEqual(
      w.agents().map((a) => a.agent),
      ['grok'],
      'dotfiles and .tmp files are not agents',
    );
    // Same size and (possibly) same mtime as before: the new inode still counts as a change.
    const t = fs.statSync(path.join(dir, 'grok.json')).mtime;
    fs.writeFileSync(path.join(dir, 'grok.json.tmp'), '{"state":"working","message":"step 2"}');
    fs.utimesSync(path.join(dir, 'grok.json.tmp'), t, t);
    fs.renameSync(path.join(dir, 'grok.json.tmp'), path.join(dir, 'grok.json'));
    await until(() => w.agents()[0]?.message === 'step 2', 'rename 2 with identical size/mtime');
    // `echo > file` truncates, then writes: the empty/partial state is not reported.
    fs.writeFileSync(path.join(dir, 'grok.json'), '');
    await sleep(300);
    fs.writeFileSync(path.join(dir, 'grok.json'), '{"state":"done",');
    await sleep(300);
    fs.writeFileSync(path.join(dir, 'grok.json'), '{"state":"done","message":"fin"}');
    await until(() => w.agents()[0]?.state === 'done', 'done after partial writes');
    await sleep(1200);
    assert.equal(sawProblem, false, 'no problem flashed for a write in progress');
    // Deleting the file removes the agent.
    fs.rmSync(path.join(dir, 'grok.json'));
    await until(() => w.agents().length === 0, 'delete clears');
    // A restarted watcher (server restart) picks up existing files as its baseline.
    fs.writeFileSync(path.join(dir, 'z.json'), '{"state":"working","message":"still here"}');
    const w2 = new StatusWatcher(dir, () => {});
    await w2.start();
    assert.equal(w2.agents()[0]?.message, 'still here');
    w2.close();
  } finally {
    clearInterval(spy);
    w.close();
  }
});

test('server: a UTF-16 file (PowerShell 5 `>`) works; switching repos shows its statuses', async () => {
  const dir = await statusDir(repo);
  const json = '{"state":"working","message":"from PowerShell","agent":"ps"}\r\n';
  fs.writeFileSync(
    path.join(dir, 'ps.json'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]),
  );
  const ps = await until(() => agentIn(lastStatus(), 'ps'), 'UTF-16 status');
  assert.equal(ps.message, 'from PowerShell');
  assert.equal(lastStatus().problems.length, 0);

  const other = path.join(tmp, 'other-repo');
  makeRepo(other);
  const otherDir = await statusDir(other);
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, 'elsewhere.json'),
    '{"state":"done","message":"other repo"}',
  );
  const r = await fetch(base + '/api/target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: other }),
  });
  assert.equal(r.status, 200);
  const st = await until(() => {
    const m = lastStatus();
    return m && agentIn(m, 'elsewhere') ? m : null;
  }, 'status of the new repo');
  assert.equal(agentIn(st, 'ps'), undefined, 'the old repo agents are gone');
  assert.equal(st.dir, otherDir);
  // And its folder is watched from now on.
  fs.writeFileSync(path.join(otherDir, 'elsewhere.json'), '{"state":"working","message":"again"}');
  await until(() => agentIn(lastStatus(), 'elsewhere')?.state === 'working', 'new repo watched');
});
