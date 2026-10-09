// Human → agent chat through the inbox (src/inbox.ts, the CLI's inbox/reply, POST /api/inbox),
// protocol versioning (protocol_version, `protocol`/`protocol ack`) and the chat view helpers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAX_CHAT_TEXT, appendMessage, inboxDir, parseInbox } from '../src/inbox.ts';
import { PROTOCOL_VERSION, parseProtocolVersion } from '../src/protocol.ts';
import { parseStatus, statusDir, writeStatus } from '../src/status.ts';
import {
  chatTargets,
  protocolInstruction,
  protocolNotice,
  questionAnswer,
  renderThread,
  unreadReplies,
} from '../public/chat-view.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.ts');
const CLI = path.join(ROOT, 'bin', 'status.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tmp: string;
let repo: string;
let proc: ChildProcess | undefined;
let ws: WebSocket | undefined;
let base: string;
const messages: { type: string; [k: string]: any }[] = [];

async function until<T>(fn: () => T, what: string, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args, '--repo', repo, '--agent', 'grok'], {
    encoding: 'utf8',
  });
const lastInbox = (): any => messages.filter((m) => m.type === 'inbox').at(-1);

/** Raw POST so tests can set Host and Origin (fetch forbids Host). */
function post(
  pathname: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-inbox-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
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

test('parseInbox: messages, read receipts and junk lines', () => {
  const text = [
    '{"type":"message","id":"h-1","ts":"2026-10-09T16:00:00Z","from":"human","text":"Hi"}',
    'not json',
    '{"type":"message","id":"h-2","ts":1760025600000,"from":"human","text":"No","re":"q1"}',
    '{"type":"read","ids":["h-1"],"ts":"2026-10-09T16:01:00Z"}',
    '{"type":"message","id":"a-1","ts":"2026-10-09T16:02:00Z","from":"agent","text":"On it","re":"bad id!"}',
    '{"type":"message","from":"human","text":"no id"}',
  ].join('\n');
  const m = parseInbox(text);
  assert.deepEqual(
    m.map((x) => [x.id, x.from, x.seen, x.re]),
    [
      ['h-1', 'human', true, undefined],
      ['h-2', 'human', false, 'q1'],
      ['a-1', 'agent', undefined, undefined],
    ],
  );
  assert.equal(m[0].ts, Date.parse('2026-10-09T16:00:00Z'));
});

test('appendMessage validates agent, text and re', async () => {
  const dir = path.join(tmp, 'validate');
  await assert.rejects(appendMessage(dir, { agent: 'a b', text: 'x' }), /"agent"/);
  await assert.rejects(appendMessage(dir, { agent: 'a', text: '   ' }), /empty/);
  await assert.rejects(appendMessage(dir, { agent: 'a', text: 42 }), /must be a string/);
  await assert.rejects(appendMessage(dir, { agent: 'a', text: 'x', re: '../q' }), /"re"/);
  await assert.rejects(
    appendMessage(dir, { agent: 'a', text: 'x'.repeat(MAX_CHAT_TEXT + 1) }),
    (err: any) => err.status === 413,
  );
  const m = await appendMessage(dir, { agent: 'a', text: '  two\r\nlines ', re: 'q1' });
  assert.equal(m.text, 'two\nlines');
  assert.equal(m.seen, false);
  assert.match(m.id, /^h-/);
  assert.equal(parseInbox(fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8'))[0].re, 'q1');
});

test('POST /api/inbox: local pages only, validated, broadcast to the UI', async () => {
  const ok = await post(
    '/api/inbox',
    JSON.stringify({ agent: 'grok', text: 'Use tabs', re: 'q1' }),
    {
      origin: base,
    },
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.json.message.text, 'Use tabs');
  const thread = await until(() => lastInbox()?.threads?.grok, 'inbox broadcast');
  assert.equal(thread.at(-1).text, 'Use tabs');
  assert.equal(thread.at(-1).seen, false);
  // Written next to the status folder in the git dir, never in the work tree.
  assert.equal(path.dirname(await inboxDir(repo)), path.dirname(await statusDir(repo)));
  assert.ok(fs.existsSync(path.join(await inboxDir(repo), 'grok.jsonl')));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');

  const evil = await post('/api/inbox', JSON.stringify({ agent: 'grok', text: 'rm -rf' }), {
    origin: 'https://evil.example',
  });
  assert.equal(evil.status, 403, 'cross-site pages cannot inject instructions');
  const rebound = await post('/api/inbox', JSON.stringify({ agent: 'grok', text: 'x' }), {
    host: 'evil.example:4477',
  });
  assert.equal(rebound.status, 403, 'DNS rebinding (foreign Host) is refused');
  assert.equal(
    (await post('/api/inbox', 'agent=grok', { 'content-type': 'text/plain' })).status,
    415,
  );
  assert.equal((await post('/api/inbox', JSON.stringify({ agent: 'grok', text: '' }))).status, 400);
  assert.equal(
    (await post('/api/inbox', JSON.stringify({ agent: 'grok', text: 'y'.repeat(4001) }))).status,
    413,
  );
  const get = await (await fetch(`${base}/api/inbox`)).json();
  assert.equal(get.threads.grok.length, 1);
});

test('CLI inbox prints only unread messages once; reply posts to the thread', async () => {
  // From the previous test: one unread message ("Use tabs", answer to q1).
  assert.equal(
    cli('inbox', '--peek').split('\n')[0],
    '1 new message from the human (instructions; reply with grok-observatory reply "…"):',
  );
  const out = cli('inbox');
  assert.match(out, /^- \[\d\d:\d\d\] \(answer to q1\) Use tabs$/m);
  assert.equal(cli('inbox'), 'No new messages.\n', 'read messages are never printed again');
  await post('/api/inbox', JSON.stringify({ agent: 'grok', text: 'Two\nlines' }));
  assert.match(cli('inbox'), /^- \[\d\d:\d\d\] Two\n  lines$/m);
  assert.equal(cli('reply', 'Done,', 'tabs', 'it', 'is', '--re', 'q1'), 'Reply posted.\n');
  const thread = await until(() => {
    const t = lastInbox()?.threads?.grok;
    return t?.some((m: any) => m.from === 'agent') && t;
  }, 'agent reply broadcast');
  assert.deepEqual(
    thread.map((m: any) => [m.from, m.seen]),
    [
      ['human', true],
      ['human', true],
      ['agent', undefined],
    ],
  );
  assert.equal(thread[2].text, 'Done, tabs it is');
  assert.equal(thread[2].re, 'q1');
  assert.throws(() => cli('reply'), /needs the message text/);
  assert.throws(() => cli('reply', 'x', '--re', 'a b'), /--re must be a question id/);
  // An agent without an inbox file.
  assert.equal(
    execFileSync(process.execPath, [CLI, 'inbox', '--repo', repo, '--agent', 'nobody'], {
      encoding: 'utf8',
    }),
    'No new messages.\n',
  );
});

test('protocol version: docs header, CLI print/ack/--protocol, kept on every write', async () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'AGENT-PROTOCOL.md'), 'utf8');
  assert.equal(Number(doc.match(/protocol_version: (\d+)/)?.[1]), PROTOCOL_VERSION);
  assert.match(doc, new RegExp(`^### v${PROTOCOL_VERSION}\\b`, 'm'), 'changelog entry');

  const printed = execFileSync(process.execPath, [CLI, 'protocol'], { cwd: tmp, encoding: 'utf8' });
  assert.match(printed, new RegExp(`^Observatory agent protocol v${PROTOCOL_VERSION}$`, 'm'));
  assert.match(printed, /AGENT-PROTOCOL\.md/);

  cli('working', 'Reading');
  const file = path.join(await statusDir(repo), 'grok.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(read().protocol_version, undefined, 'never stamped without reading');
  assert.match(cli('protocol', 'ack'), new RegExp(`Recorded protocol v${PROTOCOL_VERSION}`));
  assert.deepEqual([read().protocol_version, read().message], [PROTOCOL_VERSION, 'Reading']);
  cli('plan', 'set', 'A');
  cli('done', 'Finished');
  assert.equal(read().protocol_version, PROTOCOL_VERSION, 'kept by later commands');
  cli('working', '--protocol', '1');
  assert.equal(read().protocol_version, 1);
  assert.throws(() => cli('working', '--protocol', 'two'), /positive integer/);

  // Parser, HTTP writer and snapshot.
  assert.equal(parseStatus('{"state":"idle","protocol_version":"2"}', 'a', 1).protocol_version, 2);
  assert.equal(
    parseStatus('{"state":"idle","protocol_version":0}', 'a', 1).protocol_version,
    undefined,
  );
  assert.equal(parseProtocolVersion(1.5), undefined);
  const dir = path.join(tmp, 'pv');
  await writeStatus(dir, { state: 'working', agent: 'x', protocol_version: 2 });
  const kept = await writeStatus(dir, { state: 'done', agent: 'x' });
  assert.equal(kept.protocol_version, 2);
  await assert.rejects(writeStatus(dir, { state: 'done', agent: 'x', protocol_version: 'v2' }));
  const snap = await (await fetch(`${base}/api/status`)).json();
  assert.equal(snap.protocol.version, PROTOCOL_VERSION);
  assert.match(snap.protocol.cli, /bin[\\/]status\.mjs$/);
});

test('chat view helpers: targets, unread, receipts, protocol notices', () => {
  const agents = [
    { agent: 'old', ts: 1, protocol_version: 1 },
    { agent: 'new', ts: 5, protocol_version: 2 },
    { agent: 'mute', ts: 3 },
  ];
  const threads = {
    zeta: [],
    new: [
      { id: 'h-1', ts: 10, from: 'human', text: 'Use tabs', re: 'q1', seen: true },
      { id: 'a-1', ts: 20, from: 'agent', text: 'Done' },
      { id: 'h-2', ts: 30, from: 'human', text: 'Thanks', seen: false },
    ],
  };
  assert.deepEqual(chatTargets(agents, threads), ['new', 'mute', 'old', 'zeta']);
  assert.equal(unreadReplies(threads.new, 0), 1);
  assert.equal(unreadReplies(threads.new, 20), 0);
  assert.equal(questionAnswer(threads, 'new', 'q1')?.text, 'Use tabs');
  assert.equal(questionAnswer(threads, 'new', 'q9'), null);

  const html = renderThread(threads.new, {
    agent: 'new',
    questions: [{ id: 'q1', text: 'Tabs or spaces?' }],
  });
  assert.match(html, /chat-re-quote" title="Tabs or spaces\?"/);
  assert.match(html, /chat-receipt seen[^>]*>.*?Seen<\/span>/);
  assert.match(html, /from-human unseen[\s\S]*chat-receipt sent/);
  assert.match(renderThread([], { agent: 'new' }), /No messages yet/);
  assert.doesNotMatch(renderThread([{ id: 'x', ts: 1, from: 'human', text: '<b>' }]), /<b><\/div>/);

  const protocol = {
    version: 2,
    doc: '/x/docs/AGENT-PROTOCOL.md',
    cli: '/x/bin/status.mjs',
    url: 'https://e',
  };
  assert.equal(protocolNotice(agents[1], protocol), null);
  assert.deepEqual(protocolNotice(agents[0], protocol), {
    level: 'old',
    text: 'Agent read protocol v1; current is v2 — ask it to reread docs/AGENT-PROTOCOL.md',
  });
  assert.equal(protocolNotice(agents[2], protocol)?.level, 'missing');
  assert.equal(protocolNotice(agents[2], null), null);
  const instr = protocolInstruction(protocol, 'old');
  assert.match(instr, /\/x\/docs\/AGENT-PROTOCOL\.md/);
  assert.match(instr, /`node \/x\/bin\/status\.mjs --agent old inbox`/);
  assert.match(instr, /reply "…"/);
  assert.match(instr, /resolve <id>/);
  assert.match(instr, /`node \/x\/bin\/status\.mjs --agent old protocol ack`/);
});
