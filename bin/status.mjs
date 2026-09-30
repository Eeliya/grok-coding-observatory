#!/usr/bin/env node
// Report an agent's status to Grok Coding Observatory (see docs/AGENT-PROTOCOL.md).
// Writes <git dir>/observatory/status/<agent>.json in the repo at --repo (default: cwd).
// No dependencies and no server needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = `Usage: grok-observatory [status] <working|done|idle> [message] [options]

  working "Running lint"   busy (refresh at least every --ttl seconds)
  done "Tests pass"        finished, with an optional summary
  idle                     nothing going on

Options:
  --agent <name>   agent name (letters, digits, . _ -), default "agent"
  --ttl <seconds>  a working status older than this shows as stalled (default 600)
  --repo <path>    repository to report into (default: current directory)
  --print          print the status file path and JSON after writing`;

function fail(msg) {
  console.error(`grok-observatory: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = { agent: 'agent', repo: process.cwd() };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--print') opts.print = true;
  else if (a.startsWith('--')) {
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (!['agent', 'ttl', 'repo'].includes(key)) fail(`unknown option ${a}`);
    const value = inline ?? args[++i];
    if (value === undefined) fail(`${a} needs a value`);
    opts[key] = value;
  } else positional.push(a);
}
if (positional[0] === 'status') positional.shift();
const [state, ...words] = positional;
if (!['working', 'done', 'idle'].includes(state))
  fail('first argument must be working, done or idle');
if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.agent)) fail('--agent may only use letters, digits, . _ -');

const status = { state, agent: opts.agent, ts: new Date().toISOString() };
const message = words.join(' ').trim();
if (message) status.message = message.slice(0, 200);
if (opts.ttl !== undefined) {
  const ttl = Number(opts.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) fail('--ttl must be a positive number of seconds');
  status.ttl = ttl;
}

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

fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${opts.agent}.json`);
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(status) + '\n');
fs.renameSync(tmp, file); // atomic: the observatory never sees a half-written file
if (opts.print) console.log(`${file}\n${JSON.stringify(status)}`);
