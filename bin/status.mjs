#!/usr/bin/env node
// Report an agent's status, plan and open questions to Grok Coding Observatory, and read the
// human's chat messages (see docs/AGENT-PROTOCOL.md). Writes <git dir>/observatory/status/<agent>.json
// and appends to <git dir>/observatory/inbox/<agent>.jsonl in the repo at --repo (default: cwd).
// No dependencies and no server needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL_VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
  .observatory.protocolVersion;
const PROTOCOL_DOC = path.join(PKG_ROOT, 'docs', 'AGENT-PROTOCOL.md');
const PROTOCOL_URL =
  'https://github.com/Eeliya/grok-coding-observatory/blob/main/docs/AGENT-PROTOCOL.md';
const MAX_CHAT_TEXT = 4000;

const USAGE = `Usage: grok-observatory <command> [arguments] [options]

Status:
  working "Running lint"        busy (refresh at least every --ttl seconds)
  done "Tests pass"             finished, with an optional summary
  idle                          nothing going on
  (the word "status" may come first: grok-observatory status working "…")

Plan (optional; shown as a checklist, edits are grouped by the current step):
  plan set "Step one" "Step two" …   replace the plan (all steps pending, ids 1, 2, …)
  plan add "Another step"            append a step
  plan clear                         remove the plan
  step start <id|n> [note]           make a step current. Moving forward marks the previously
                                     active step done; jumping back puts it back to pending.
                                     Earlier steps never marked done/skipped are listed as a hint
  step done [id|n]                   mark a step done (default: the current one)
  step skip <id|n>                   mark a step skipped

Questions for the human (shown prominently until resolved):
  ask "Should codes stack with sales?" [--option Yes --option No] [--blocking] [--id q1]
  resolve <id|all>                   remove an answered question

Chat with the human (messages typed in the observatory wait in your inbox; check it before
and after each step, before your final reply, and while waiting on a blocking question):
  inbox [--peek]                     print only unread messages and mark them read
                                     ("No new messages." when there are none)
  reply "Done, see the diff" [--re q1]   post a reply in the observatory chat (alias: say)

Protocol:
  protocol                           print the protocol version and where to read it
  protocol ack                       record that you read the current version (protocol_version)

Options:
  --agent <name>    agent name (letters, digits, . _ -), default "agent"
  --ttl <seconds>   a working status older than this shows as stalled (default 600)
  --repo <path>     repository to report into (default: current directory)
  -m, --message <t> status message for plan/step/ask commands
  --print           print the status file path and JSON after writing
  --protocol <n>    set protocol_version (the docs/AGENT-PROTOCOL.md version you read)

Every status command keeps the plan, questions and protocol_version already in the file.`;

function fail(msg) {
  console.error(`grok-observatory: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = { agent: 'agent', repo: process.cwd(), option: [] };
const positional = [];
const VALUE_OPTS = ['agent', 'ttl', 'repo', 'message', 'option', 'id', 're', 'protocol'];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--print') opts.print = true;
  else if (a === '--blocking') opts.blocking = true;
  else if (a === '--peek') opts.peek = true;
  else if (a === '-m' || a.startsWith('--')) {
    const [rawKey, inline] = a === '-m' ? ['message'] : a.slice(2).split(/=(.*)/s);
    const key = rawKey === 'options' ? 'option' : rawKey;
    if (!VALUE_OPTS.includes(key)) fail(`unknown option ${a}`);
    const value = inline ?? args[++i];
    if (value === undefined) fail(`${a} needs a value`);
    if (key === 'option') opts.option.push(value);
    else opts[key] = value;
  } else positional.push(a);
}
if (positional[0] === 'status') positional.shift();
if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.agent)) fail('--agent may only use letters, digits, . _ -');
const [cmd, ...rest] = positional;
if (!cmd) fail('missing command');

if (cmd === 'protocol' && rest[0] !== 'ack') {
  // Works anywhere (no repo needed).
  if (rest.length) fail('protocol takes no arguments except "ack"');
  console.log(
    `Observatory agent protocol v${PROTOCOL_VERSION}\n` +
      `Read: ${PROTOCOL_DOC}\n` +
      `Online: ${PROTOCOL_URL}\n` +
      `After reading it: grok-observatory protocol ack --agent ${opts.agent}`,
  );
  process.exit(0);
}
let protocolOpt;
if (opts.protocol !== undefined) {
  protocolOpt = Number(opts.protocol);
  if (!Number.isInteger(protocolOpt) || protocolOpt < 1)
    fail('--protocol must be a positive integer');
}

let dir;
let inboxDir;
try {
  [dir, inboxDir] = execFileSync(
    'git',
    [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'observatory/status',
      '--git-path',
      'observatory/inbox',
    ],
    { cwd: path.resolve(opts.repo), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .trim()
    .split(/\r?\n/);
} catch (err) {
  console.error(
    `grok-observatory: ${path.resolve(opts.repo)} is not a git repository\n${err.stderr ?? ''}`,
  );
  process.exit(1);
}
const file = path.join(dir, `${opts.agent}.json`);
const inboxFile = path.join(inboxDir, `${opts.agent}.jsonl`);

/** Inbox lines (bad ones skipped): messages and the ids already read. */
function readInbox() {
  let text = '';
  try {
    text = fs.readFileSync(inboxFile, 'utf8');
  } catch {
    // no inbox yet
  }
  const messages = [];
  const read = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d?.type === 'read' && Array.isArray(d.ids)) for (const id of d.ids) read.add(String(id));
      else if (d?.type === 'message' && typeof d.text === 'string' && d.id != null)
        messages.push(d);
    } catch {
      // skip
    }
  }
  return { messages, read };
}
const appendInbox = (obj) => {
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.appendFileSync(inboxFile, JSON.stringify(obj) + '\n'); // O_APPEND: lines never interleave
};
const hhmm = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? '--:--'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

if (cmd === 'inbox') {
  if (rest.length) fail('inbox takes no arguments');
  const { messages, read } = readInbox();
  const unread = messages.filter((m) => m.from !== 'agent' && !read.has(String(m.id)));
  if (!unread.length) {
    console.log('No new messages.');
    process.exit(0);
  }
  const lines = unread.map((m) => {
    const re = typeof m.re === 'string' ? ` (answer to ${m.re})` : '';
    const text = String(m.text).trim().replace(/\r?\n/g, '\n  ');
    return `- [${hhmm(m.ts)}]${re} ${text}`;
  });
  console.log(
    `${unread.length} new message${unread.length === 1 ? '' : 's'} from the human (instructions; reply with grok-observatory reply "…"):\n` +
      lines.join('\n'),
  );
  if (!opts.peek) {
    appendInbox({
      type: 'read',
      ids: unread.map((m) => String(m.id)),
      ts: new Date().toISOString(),
    });
  }
  process.exit(0);
}
if (cmd === 'reply' || cmd === 'say') {
  const text = rest.join(' ').replace(/\r\n?/g, '\n').trim();
  if (!text) fail(`${cmd} needs the message text`);
  if (text.length > MAX_CHAT_TEXT) fail(`the message is longer than ${MAX_CHAT_TEXT} characters`);
  if (opts.re !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.re))
    fail('--re must be a question id');
  const ts = Date.now();
  const msg = {
    type: 'message',
    id: `a-${ts.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date(ts).toISOString(),
    from: 'agent',
    text,
  };
  if (opts.re) msg.re = opts.re;
  appendInbox(msg);
  console.log('Reply posted.');
  process.exit(0);
}

/** The current file (plan, questions and any extra fields are kept). */
function readExisting() {
  try {
    let text = fs.readFileSync(file);
    if (text[0] === 0xff && text[1] === 0xfe) text = text.subarray(2).toString('utf16le');
    else text = text.toString('utf8');
    const d = JSON.parse(text.replace(/^\uFEFF/, ''));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

const prev = readExisting();
const status = {};
// Only the protocol's plan fields carry over; state, message and ttl are set fresh as before.
for (const k of ['plan', 'step', 'questions', 'protocol_version'])
  if (prev[k] != null) status[k] = prev[k];
if (protocolOpt !== undefined) status.protocol_version = protocolOpt;
let state = ['working', 'done', 'idle'].includes(prev.state) ? prev.state : 'working';
let message = opts.message;

const steps = () => (Array.isArray(status.plan) ? status.plan : []);
function findStep(ref) {
  const list = steps();
  if (ref == null || ref === '') {
    const cur =
      list.find((s) => String(s.id) === String(status.step)) ??
      list.find((s) => s.state === 'active');
    if (!cur) fail('no current step; give a step id or number');
    return cur;
  }
  const byId = list.find((s) => String(s.id) === String(ref));
  if (byId) return byId;
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
  fail(`no step "${ref}" in the plan (${list.map((s) => s.id).join(', ') || 'no plan'})`);
}
const words = (list) => list.join(' ').trim();
/** "1-3, 5" for step positions [1, 2, 3, 5]. */
function ranges(ns) {
  const out = [];
  for (const n of ns) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, z]) => (a === z ? `${a}` : `${a}-${z}`)).join(', ');
}
/** Working out of order is fine, but a forgotten "step done" leaves the checklist behind: hint. */
function hintOpenBefore(target) {
  const list = steps();
  const open = [];
  for (const [i, s] of list.entries()) {
    if (s === target) break;
    if (s.state === 'pending' || s.state == null) open.push(i + 1);
  }
  if (!open.length) return;
  const which = open.length === 1 ? `Step ${open[0]} is` : `Steps ${ranges(open)} are`;
  process.stderr.write(
    `${which} still open; mark them with \`step done <n>\` or \`step skip <n>\` if finished.\n`,
  );
}

if (['working', 'done', 'idle'].includes(cmd)) {
  state = cmd;
  message = words(rest) || opts.message;
} else if (cmd === 'plan') {
  const [sub, ...titles] = rest;
  if (sub === 'set') {
    if (!titles.length) fail('plan set needs at least one step title');
    status.plan = titles.map((title, i) => ({ id: String(i + 1), title, state: 'pending' }));
    delete status.step;
  } else if (sub === 'add') {
    if (!titles.length) fail('plan add needs a step title');
    const list = steps();
    const used = new Set(list.map((s) => String(s.id)));
    let n = list.length + 1;
    while (used.has(String(n))) n++;
    status.plan = [...list, { id: String(n), title: words(titles), state: 'pending' }];
  } else if (sub === 'clear') {
    delete status.plan;
    delete status.step;
  } else fail('plan needs set, add or clear');
} else if (cmd === 'step') {
  const [sub, ref, ...note] = rest;
  if (!steps().length) fail('no plan yet: run "plan set …" first');
  if (sub === 'start') {
    if (!ref) fail('step start needs a step id or number');
    const target = findStep(ref);
    // Moving forward finishes the step you were on; jumping back does not (no auto-tick).
    const list = steps();
    const at = list.indexOf(target);
    for (const [i, s] of list.entries()) {
      if (s === target || s.state !== 'active') continue;
      if (i < at) s.state = 'done';
      else {
        s.state = 'pending';
        process.stderr.write(
          `Step ${i + 1} is back to pending (not marked done); run \`step done ${i + 1}\` if it is finished.\n`,
        );
      }
    }
    target.state = 'active';
    hintOpenBefore(target);
    if (note.length) target.note = words(note);
    status.step = String(target.id);
    state = 'working';
    message = message ?? target.title;
  } else if (sub === 'done' || sub === 'skip') {
    const target = findStep(ref);
    target.state = sub === 'done' ? 'done' : 'skipped';
    if (String(status.step) === String(target.id)) delete status.step;
  } else fail('step needs start, done or skip');
} else if (cmd === 'ask') {
  const text = words(rest);
  if (!text) fail('ask needs the question text');
  const list = Array.isArray(status.questions) ? status.questions : [];
  const used = new Set(list.map((q) => String(q.id)));
  let id = opts.id;
  if (!id) {
    let n = list.length + 1;
    while (used.has(`q${n}`)) n++;
    id = `q${n}`;
  }
  const q = { id, text, asked_at: new Date().toISOString() };
  if (opts.option.length) q.options = opts.option;
  if (opts.blocking) q.blocking = true;
  status.questions = [...list.filter((x) => String(x.id) !== id), q];
  if (!opts.print) console.log(id);
} else if (cmd === 'resolve') {
  const [ref] = rest;
  if (!ref) fail('resolve needs a question id (or "all")');
  const list = Array.isArray(status.questions) ? status.questions : [];
  const left = ref === 'all' ? [] : list.filter((q) => String(q.id) !== ref);
  if (left.length === list.length && ref !== 'all') fail(`no open question "${ref}"`);
  if (left.length) status.questions = left;
  else delete status.questions;
} else if (cmd === 'protocol') {
  // protocol ack: the agent read the current docs; state and message stay as they were.
  status.protocol_version = PROTOCOL_VERSION;
  if (typeof prev.message === 'string' && message === undefined) message = prev.message;
  console.log(`Recorded protocol v${PROTOCOL_VERSION} for agent ${opts.agent}.`);
} else {
  fail(`unknown command "${cmd}"`);
}

const out = { state, agent: opts.agent, ts: new Date().toISOString() };
if (message) out.message = String(message).slice(0, 200);
if (opts.ttl !== undefined) {
  const ttl = Number(opts.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) fail('--ttl must be a positive number of seconds');
  out.ttl = ttl;
}
Object.assign(out, status);

fs.mkdirSync(dir, { recursive: true });
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(out) + '\n');
fs.renameSync(tmp, file); // atomic: the observatory never sees a half-written file
if (opts.print) console.log(`${file}\n${JSON.stringify(out)}`);
