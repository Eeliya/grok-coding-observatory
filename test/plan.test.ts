// Agent plan, step attribution and open questions: protocol parsing, watcher activity, the CLI,
// the HTTP API, edits attributed to the current step, and the UI view helpers (public/plan-view.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  StatusWatcher,
  parseStatus,
  planEvents,
  statusDir,
  writeStatus,
  type StatusLogEntry,
} from '../src/status.ts';
import {
  countEditsByStep,
  editMatchesStep,
  openQuestions,
  planSummary,
  questionClipboard,
  questionCounts,
  renderPlanPanel,
  renderQuestionCards,
  displayPlan,
  stepKey,
  stepTitle,
} from '../public/plan-view.js';

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
const statusFile = async () => path.join(await statusDir(repo), 'grok.json');
const readFile = async () => JSON.parse(fs.readFileSync(await statusFile(), 'utf8'));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-plan-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'cart.js'), 'export const items = [];\n');
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

const lastStatus = (): any => messages.filter((m) => m.type === 'status').at(-1);
const grok = () => lastStatus()?.agents?.find((a: any) => a.agent === 'grok');

test('parseStatus: old files are unchanged; plan, step and questions are optional', () => {
  const old = parseStatus('{"state":"working","message":"Lint","agent":"a","ts":5}', 'a', 1);
  assert.deepEqual(Object.keys(old).sort(), ['agent', 'message', 'state', 'ts', 'ttl']);

  const s = parseStatus(
    JSON.stringify({
      state: 'working',
      plan: [
        { id: 'read', title: 'Read the code', state: 'completed' },
        { title: 'Add codes', state: 'in_progress', note: 'DISCOUNTS table' },
        'Write tests',
        { title: '' }, // dropped: no title
        { id: 'read', title: 'Duplicate id', state: 'weird' },
      ],
      questions: [
        {
          id: 'q1',
          text: 'Stack with sales?',
          options: ['Yes', '', 'No'],
          blocking: true,
          asked_at: 1790000000,
        },
        { id: 'q2', text: 'Old one', resolved: true },
        'Plain string question',
        { text: '' },
      ],
    }),
    'grok',
    1000,
  );
  assert.deepEqual(s.plan, [
    { id: 'read', title: 'Read the code', state: 'done' },
    { id: '2', title: 'Add codes', state: 'active', note: 'DISCOUNTS table' },
    { id: '3', title: 'Write tests', state: 'pending' },
    { id: 'read-5', title: 'Duplicate id', state: 'pending' },
  ]);
  assert.equal(s.step, '2', 'derived from the first active step');
  assert.deepEqual(s.questions, [
    {
      id: 'q1',
      text: 'Stack with sales?',
      options: ['Yes', 'No'],
      blocking: true,
      askedAt: 1790000000000,
    },
    { id: 'q3', text: 'Plain string question', options: [], blocking: false, askedAt: s.ts },
  ]);

  // An explicit `step` wins and is shown as active even if the file still says pending.
  const e = parseStatus(
    '{"state":"working","step":"b","plan":[{"id":"a","title":"A","state":"active"},{"id":"b","title":"B"}]}',
    'x',
    1,
  );
  assert.equal(e.step, 'b');
  assert.equal(e.plan![1].state, 'active');
  // Unknown step ids fall back; garbage plan/questions are ignored, not fatal.
  assert.equal(parseStatus('{"state":"idle","step":"zz","plan":["A"]}', 'x', 1).step, null);
  const junk = parseStatus('{"state":"idle","plan":"nope","questions":{"a":1}}', 'x', 1);
  assert.equal(junk.plan, undefined);
  assert.equal(junk.questions, undefined);
  // Limits.
  const many = parseStatus(
    JSON.stringify({ state: 'idle', plan: Array.from({ length: 50 }, (_, i) => `S${i}`) }),
    'x',
    1,
  );
  assert.equal(many.plan!.length, 30);
});

test('planEvents: a new current step and each new question become activity', () => {
  const a = parseStatus('{"state":"working","plan":["A","B"],"step":"1"}', 'g', 1);
  const b = parseStatus(
    '{"state":"working","plan":["A","B"],"step":"2","questions":[{"id":"q1","text":"Why?","blocking":true}]}',
    'g',
    2,
  );
  const ev = planEvents(a, b);
  assert.deepEqual(
    ev.map((e) => [e.kind, e.ref, e.message, e.blocking]),
    [
      ['step', '2', 'Step 2/2: B', undefined],
      ['question', 'q1', 'Asked: Why?', true],
    ],
  );
  assert.deepEqual(planEvents(b, b), [], 'a refresh is not new activity');
});

test('StatusWatcher: step/question activity and the current step for attribution', async () => {
  const dir = path.join(tmp, 'watch');
  fs.mkdirSync(dir, { recursive: true });
  const seen: StatusLogEntry[] = [];
  const w = new StatusWatcher(dir, (_w, t) => seen.push(...t));
  await w.start();
  try {
    assert.equal(w.currentStep(), null, 'no plan: nothing to attribute');
    const write = (o: object) => fs.writeFileSync(path.join(dir, 'g.json'), JSON.stringify(o));
    write({ state: 'working', plan: ['Read', 'Change'], step: '1' });
    await until(() => w.currentStep()?.id === '1', 'step 1');
    assert.deepEqual(w.currentStep(), { agent: 'g', id: '1', title: 'Read', n: 1, of: 2 });
    write({ state: 'working', plan: ['Read', 'Change'], step: '2', questions: ['Ok?'] });
    await until(() => w.currentStep()?.id === '2', 'step 2');
    await until(() => seen.some((e) => e.kind === 'question'), 'question activity');
    assert.ok(seen.some((e) => e.kind === 'step' && e.ref === '2'));
    write({ state: 'done', plan: ['Read', 'Change'], step: '2' });
    await until(() => w.agents()[0]?.state === 'done', 'done');
    assert.equal(w.currentStep(), null, 'a finished agent does not claim new edits');
  } finally {
    w.close();
  }
});

test('CLI: plan set / step start / ask / resolve, and status updates keep the plan', async () => {
  cli('plan', 'set', 'Read the cart code', 'Add discount codes', 'Write tests');
  let f = await readFile();
  assert.deepEqual(
    f.plan.map((s: any) => [s.id, s.state]),
    [
      ['1', 'pending'],
      ['2', 'pending'],
      ['3', 'pending'],
    ],
  );
  cli('step', 'start', '1');
  cli('step', 'start', '2', 'DISCOUNTS', 'table');
  f = await readFile();
  assert.equal(f.state, 'working');
  assert.equal(f.step, '2');
  assert.equal(f.message, 'Add discount codes');
  assert.deepEqual(
    f.plan.map((s: any) => s.state),
    ['done', 'active', 'pending'],
    'starting a step finishes the previous one',
  );
  assert.equal(f.plan[1].note, 'DISCOUNTS table');

  const id = cli(
    'ask',
    'Should codes stack with sales?',
    '--option',
    'Yes',
    '--option',
    'No',
    '--blocking',
  ).trim();
  assert.equal(id, 'q1');
  cli('working', 'Still', 'going'); // a plain status update keeps the plan and questions
  f = await readFile();
  assert.equal(f.message, 'Still going');
  assert.equal(f.plan.length, 3);
  assert.deepEqual(f.questions[0].options, ['Yes', 'No']);
  assert.equal(f.questions[0].blocking, true);
  assert.ok(Date.parse(f.questions[0].asked_at) > 0);

  const g = await until(() => grok()?.questions?.length === 1 && grok(), 'question broadcast');
  assert.equal(g.step, '2');
  assert.equal(g.questions[0].text, 'Should codes stack with sales?');

  cli('resolve', 'q1');
  f = await readFile();
  assert.equal(f.questions, undefined);
  await until(() => grok() && !grok().questions?.length, 'question resolved');

  cli('step', 'done');
  f = await readFile();
  assert.equal(f.plan[1].state, 'done');
  assert.equal(f.step, undefined);
  cli('plan', 'add', 'Update docs');
  assert.equal((await readFile()).plan.at(-1).id, '4');
  assert.throws(() => cli('step', 'start', '9'), /no step "9"/);
  assert.throws(() => cli('resolve', 'nope'), /no open question/);
  cli('plan', 'clear');
  assert.equal((await readFile()).plan, undefined);
});

test('CLI: working out of order never ticks steps, but hints at the open ones', async () => {
  const as = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args, '--repo', repo, '--agent', 'jumper'], {
      encoding: 'utf8',
    });
  const file = async () =>
    JSON.parse(fs.readFileSync(path.join(await statusDir(repo), 'jumper.json'), 'utf8'));
  as('plan', 'set', 'A', 'B', 'C', 'D', 'E', 'F');
  as('step', 'skip', '3');
  assert.match(
    as('step', 'start', '2').stderr,
    /^Step 1 is still open; mark them with `step done <n>` or `step skip <n>`/,
  );
  const r = as('step', 'start', '6');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Steps 1, 4-5 are still open/);
  const f = await file();
  assert.deepEqual(
    f.plan.map((s: any) => s.state),
    ['pending', 'done', 'skipped', 'pending', 'pending', 'active'],
    'open steps are left alone (only the previously active one is finished, as before)',
  );
  as('step', 'done', '1');
  as('step', 'skip', '4');
  as('step', 'done', '5');
  assert.equal(as('step', 'start', '6').stderr, '', 'no hint once everything before is marked');
  as('plan', 'clear');
  as('idle');
  await until(() => {
    const j = lastStatus()?.agents?.find((a: any) => a.agent === 'jumper');
    return j && j.state === 'idle' && !j.plan;
  }, 'jumper cleared');
});

test('writeStatus (HTTP API) keeps an existing plan and accepts new fields', async () => {
  const dir = path.join(tmp, 'http-plan');
  await writeStatus(dir, { state: 'working', agent: 'h', plan: [{ title: 'A' }], step: '1' });
  await writeStatus(dir, { state: 'done', agent: 'h', message: 'ok' });
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'h.json'), 'utf8'));
  assert.deepEqual(f.plan, [{ title: 'A' }]);
  assert.equal(f.step, '1');
  await writeStatus(dir, { state: 'done', agent: 'h', plan: null });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'h.json'), 'utf8')).plan, undefined);
  await assert.rejects(
    writeStatus(dir, { state: 'done', agent: 'h', plan: 'x' }),
    /must be an array/,
  );
});

test('server: edits are attributed to the step that was current when they happened', async () => {
  cli('plan', 'set', 'Read', 'Change cart');
  cli('step', 'start', '1');
  await until(() => grok()?.step === '1', 'step 1 live');
  fs.appendFileSync(path.join(repo, 'cart.js'), '// read\n');
  const e1 = await until(
    () => messages.find((m) => m.type === 'change' && m.after.includes('// read')),
    'edit in step 1',
  );
  assert.deepEqual(e1.step, { agent: 'grok', id: '1', title: 'Read', n: 1, of: 2 });

  cli('step', 'start', '2');
  await until(() => grok()?.step === '2', 'step 2 live');
  fs.appendFileSync(path.join(repo, 'cart.js'), '// changed\n');
  const e2 = await until(
    () => messages.find((m) => m.type === 'change' && m.after.includes('// changed')),
    'edit in step 2',
  );
  assert.equal(e2.step.id, '2');

  cli('done', 'Finished');
  await until(() => grok()?.state === 'done', 'done live');
  fs.appendFileSync(path.join(repo, 'cart.js'), '// after\n');
  const e3 = await until(
    () => messages.find((m) => m.type === 'change' && m.after.includes('// after')),
    'edit after done',
  );
  assert.equal(e3.step, undefined, 'no step once the agent is done');

  // The summarized history (sent on page load) keeps the step, plus a step marker.
  const history = await (await fetch(base + '/api/history')).json();
  const edits = history.items.filter((i: any) => i.type === 'edit');
  assert.deepEqual(
    edits.map((i: any) => i.step?.id ?? null),
    ['1', '2', null],
  );
  assert.ok(history.items.some((i: any) => i.kind === 'step' && i.ref === '2'));
});

test('plan-view: steps worked on but not marked done are flagged, never counted', () => {
  const plan = [
    'pending',
    'pending',
    'skipped',
    'pending',
    'pending',
    'pending',
    'pending',
    'pending',
  ].map((state, i) => ({ id: String(i + 1), title: `S${i + 1}`, state }));
  // Edits on steps 1, 2, 4, 5 and 6; nothing marked done; step 6 is current.
  const counts = new Map(
    [
      ['1', 3],
      ['2', 47],
      ['4', 42],
      ['5', 17],
      ['6', 17],
    ].map(([id, n]) => [stepKey('website', id as string), n as number]),
  );
  const shown = displayPlan(plan, '6', counts, 'website');
  assert.deepEqual(
    shown.map((s: any) => (s.open ? 'open' : s.state)),
    ['open', 'open', 'skipped', 'open', 'open', 'active', 'pending', 'pending'],
  );
  assert.equal(plan[0].state, 'pending', 'input untouched');
  const agent = { agent: 'website', state: 'working', ts: 1, plan, step: '6' };
  const sum = planSummary(agent);
  assert.deepEqual([sum!.done, sum!.total, sum!.current!.n], [1, 8, 6], 'only skipped counts');
  const html = renderPlanPanel([agent], { counts });
  assert.match(html, /1\/8 done/);
  assert.equal((html.match(/ps-pending ps-open/g) ?? []).length, 4);
  assert.equal((html.match(/icon-circle-dashed/g) ?? []).length, 4);
  assert.match(html, /has edits but the agent hasn&#39;t marked it done/);
  assert.match(html, /ps-active ps-current/);
  assert.doesNotMatch(html, /ps-done/);

  // Without edits a pending step stays a plain empty circle; the step field makes its step
  // active; a stale "active" elsewhere is shown as open; explicit done stays done.
  const stale = [
    { id: '1', title: 'A', state: 'active' },
    { id: '2', title: 'B', state: 'pending' },
    { id: '3', title: 'C', state: 'pending' },
    { id: '4', title: 'D', state: 'done' },
  ];
  assert.deepEqual(
    displayPlan(stale, '2').map((s: any) => (s.open ? 'open' : s.state)),
    ['open', 'active', 'pending', 'done'],
  );
  assert.deepEqual(
    displayPlan([{ id: '1', title: 'A', state: 'done' }], '1').map((s: any) => s.state),
    ['done'],
  );
  assert.deepEqual(displayPlan(undefined, '1'), []);
});

test('plan-view: summary, counts, filter and rendering', () => {
  const agents = [
    {
      agent: 'grok',
      state: 'working',
      ts: 2,
      step: '2',
      plan: [
        { id: '1', title: 'Read', state: 'done' },
        { id: '2', title: 'Add <codes>', state: 'active', note: 'why' },
        { id: '3', title: 'Tests', state: 'pending' },
        { id: '4', title: 'Docs', state: 'skipped' },
      ],
      questions: [
        { id: 'q1', text: 'Later?', options: [], blocking: false, askedAt: 100 },
        {
          id: 'q2',
          text: 'Stack with sales?',
          options: ['Yes', 'No'],
          blocking: true,
          askedAt: 200,
        },
      ],
    },
    { agent: 'other', state: 'idle', ts: 1 },
  ];
  assert.deepEqual(planSummary(agents[0]), {
    done: 2,
    total: 4,
    current: { id: '2', title: 'Add <codes>', n: 2, of: 4 },
  });
  assert.equal(planSummary(agents[1]), null);

  const s2 = { agent: 'grok', id: '2', title: 'Add', n: 2, of: 4 };
  const timeline = [
    { type: 'edit', id: 1, step: { ...s2, id: '1', n: 1 } },
    { type: 'edit', id: 2, step: s2 },
    { type: 'edit', id: 3, step: s2 },
    { type: 'edit', id: 4 },
    { type: 'marker', id: 5 },
  ];
  const counts = countEditsByStep(timeline);
  assert.equal(counts.get('grok\u00002'), 2);
  assert.equal(counts.get('grok\u00001'), 1);
  const f = { agent: 'grok', id: '2' };
  assert.deepEqual(
    timeline.filter((i) => i.type === 'edit' && editMatchesStep(i, f)).map((i) => i.id),
    [2, 3],
  );
  assert.ok(editMatchesStep(timeline[3], null), 'no filter matches everything');
  assert.equal(stepTitle(s2), 'Step 2/4: Add (grok)');

  const html = renderPlanPanel(agents, { counts, filter: f });
  assert.match(html, /Step 2\/4/);
  assert.match(html, /2\/4 done/);
  assert.match(html, /Add &lt;codes&gt;/, 'escaped');
  assert.match(html, /ps ps-active ps-current selected/);
  assert.match(html, /ps-skipped/);
  assert.match(html, /<span class="ps-count">2<\/span>/);
  assert.match(html, /Show all/);
  assert.doesNotMatch(renderPlanPanel(agents, { collapsed: true }), /plan-steps/);
  assert.equal(renderPlanPanel([{ agent: 'a', state: 'idle', ts: 1 }]), '', 'no plan: no panel');

  assert.deepEqual(questionCounts(agents), { open: 2, blocking: 1 });
  assert.deepEqual(
    openQuestions(agents).map((q) => q.id),
    ['q2', 'q1'],
    'blocking first',
  );
  const cards = renderQuestionCards(agents, 200 + 3 * 60_000);
  assert.match(cards, /q-card blocking/);
  assert.match(cards, /Blocking/);
  assert.match(cards, /asked 3m ago/);
  assert.match(cards, /<li>Yes<\/li><li>No<\/li>/);
  assert.equal(renderQuestionCards([{ agent: 'a' }]), '');
  assert.equal(
    questionClipboard({ agent: 'grok', text: 'Stack?', options: ['Yes', 'No'] }),
    'grok asked: Stack?\nOptions:\n  1. Yes\n  2. No\nMy answer: ',
  );
});
