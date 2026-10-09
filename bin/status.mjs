#!/usr/bin/env node
// Report an agent's status, plan and open questions to Grok Coding Observatory
// (see docs/AGENT-PROTOCOL.md). Writes <git dir>/observatory/status/<agent>.json in the repo at
// --repo (default: cwd). No dependencies and no server needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

Options:
  --agent <name>    agent name (letters, digits, . _ -), default "agent"
  --ttl <seconds>   a working status older than this shows as stalled (default 600)
  --repo <path>     repository to report into (default: current directory)
  -m, --message <t> status message for plan/step/ask commands
  --print           print the status file path and JSON after writing

Every command keeps the plan and questions already in the file.`;

function fail(msg) {
  console.error(`grok-observatory: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = { agent: 'agent', repo: process.cwd(), option: [] };
const positional = [];
const VALUE_OPTS = ['agent', 'ttl', 'repo', 'message', 'option', 'id'];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--print') opts.print = true;
  else if (a === '--blocking') opts.blocking = true;
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

let dir;
try {
  dir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'observatory/status'],
    { cwd: path.resolve(opts.repo), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
} catch (err) {
  console.error(
    `grok-observatory: ${path.resolve(opts.repo)} is not a git repository\n${err.stderr ?? ''}`,
  );
  process.exit(1);
}
const file = path.join(dir, `${opts.agent}.json`);

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
for (const k of ['plan', 'step', 'questions']) if (prev[k] != null) status[k] = prev[k];
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
