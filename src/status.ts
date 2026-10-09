// Agent status protocol: agents drop small JSON files into <git dir>/observatory/status/
// (one per agent); this module parses them and watches the folder. See docs/AGENT-PROTOCOL.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROTOCOL_INFO, parseProtocolVersion } from './protocol.ts';
import { git } from './git.ts';

export const STATUS_STATES = ['working', 'done', 'idle'] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export const DEFAULT_TTL_S = 600;
export const MAX_MESSAGE = 200;
const MAX_FILE_BYTES = 64 * 1024;
/** A file that fails to parse this soon after a write may still be mid-write: retry first. */
const SETTLE_MS = 1000;
const POLL_MS = 1000;
const LOG_MAX = 50;
export const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface AgentStatus {
  agent: string;
  state: StatusState;
  message: string;
  /** Epoch ms of the update (from `ts`, else the file's mtime). */
  ts: number;
  /** Seconds a `working` status stays fresh without a refresh. */
  ttl: number;
  /** Optional plan: ordered steps (absent when the agent publishes none). */
  plan?: PlanStep[];
  /** Id of the current step (explicit `step`, else the first `active` one). */
  step?: string | null;
  /** Open questions for the human (resolved ones are left out). */
  questions?: Question[];
  /** docs/AGENT-PROTOCOL.md version the agent last read (absent: never reported). */
  protocol_version?: number;
}
export const STEP_STATES = ['pending', 'active', 'done', 'skipped'] as const;
export type StepState = (typeof STEP_STATES)[number];
export interface PlanStep {
  id: string;
  title: string;
  state: StepState;
  note?: string;
}
export interface Question {
  id: string;
  text: string;
  options: string[];
  blocking: boolean;
  /** Epoch ms when it was asked (from `asked_at`, else the status time). */
  askedAt: number;
}
export const MAX_STEPS = 30;
export const MAX_QUESTIONS = 10;
const MAX_TITLE = 200;
const MAX_NOTE = 300;
const MAX_QUESTION = 500;
const MAX_OPTIONS = 8;
const MAX_OPTION = 120;
/** Common synonyms agents use for step states (e.g. Claude Code's todo list). */
const STEP_ALIASES: Record<string, StepState> = {
  todo: 'pending',
  open: 'pending',
  in_progress: 'active',
  'in-progress': 'active',
  doing: 'active',
  current: 'active',
  working: 'active',
  completed: 'done',
  complete: 'done',
  finished: 'done',
  skip: 'skipped',
  cancelled: 'skipped',
  canceled: 'skipped',
};
export interface StatusProblem {
  file: string;
  error: string;
}
export interface StatusLogEntry {
  agent: string;
  state: StatusState;
  message: string;
  /** Absent for a state/message change; "step" = new current step; "question" = new question. */
  kind?: 'step' | 'question';
  /** For kind "step": the step id; for "question": the question id. */
  ref?: string;
  /** For kind "question": it blocks the agent. */
  blocking?: boolean;
  ts: number;
}

/** Absolute status folder of the work tree at `cwd` (per worktree, never committed). */
export async function statusDir(cwd: string): Promise<string> {
  const out = await git(
    ['rev-parse', '--path-format=absolute', '--git-path', 'observatory/status'],
    cwd,
  );
  return out.trim();
}

function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/**
 * Parse one status file. `fallbackAgent` is the file name without `.json`; `mtimeMs`
 * is used when the file has no (valid) `ts`. Throws with a readable reason when invalid.
 */
export function parseStatus(text: string, fallbackAgent: string, mtimeMs: number): AgentStatus {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, '')); // tolerate a UTF-8 BOM (PowerShell 5)
  } catch {
    throw new Error('not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('not a JSON object');
  const d = data as Record<string, unknown>;
  const state = String(d.state ?? '').toLowerCase();
  if (!(STATUS_STATES as readonly string[]).includes(state)) {
    throw new Error(`"state" must be one of ${STATUS_STATES.join(', ')}`);
  }
  let agent = typeof d.agent === 'string' && d.agent.trim() ? d.agent.trim() : fallbackAgent;
  if (!AGENT_RE.test(agent)) agent = agent.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'agent';
  const ttl = Number(d.ttl);
  const status: AgentStatus = {
    agent,
    state: state as StatusState,
    message:
      typeof d.message === 'string'
        ? d.message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
        : '',
    ts: parseTs(d.ts) ?? mtimeMs,
    ttl: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 7 * 24 * 3600) : DEFAULT_TTL_S,
  };
  const pv = parseProtocolVersion(d.protocol_version);
  if (pv !== undefined) status.protocol_version = pv;
  const ts = status.ts;
  const plan = parsePlan(d.plan);
  if (plan) {
    status.plan = plan;
    const explicit = d.step == null || d.step === '' ? null : String(d.step);
    status.step =
      (explicit && plan.some((s) => s.id === explicit) ? explicit : null) ??
      plan.find((s) => s.state === 'active')?.id ??
      null;
    // The current step is shown as active even if the file still says "pending".
    const cur = plan.find((s) => s.id === status.step);
    if (cur && cur.state === 'pending') cur.state = 'active';
  }
  const questions = parseQuestions(d.questions, ts);
  if (questions) status.questions = questions;
  return status;
}

const clip = (v: unknown, max: number) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

/** Lenient: bad entries are skipped rather than rejecting the whole file. */
export function parsePlan(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: PlanStep[] = [];
  const ids = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (steps.length >= MAX_STEPS) break;
    const o: Record<string, unknown> =
      typeof item === 'string' ? { title: item } : item && typeof item === 'object' ? item : {};
    const title = clip(o.title ?? o.text ?? o.content, MAX_TITLE);
    if (!title) continue;
    let id = clip(o.id, 64) || String(i + 1);
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const s = String(o.state ?? o.status ?? 'pending').toLowerCase();
    const state = (STEP_STATES as readonly string[]).includes(s)
      ? (s as StepState)
      : (STEP_ALIASES[s] ?? 'pending');
    const step: PlanStep = { id, title, state };
    const note = clip(o.note ?? o.why, MAX_NOTE);
    if (note) step.note = note;
    steps.push(step);
  }
  return steps.length ? steps : undefined;
}

export function parseQuestions(raw: unknown, fallbackTs: number): Question[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Question[] = [];
  const ids = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (out.length >= MAX_QUESTIONS) break;
    const o: Record<string, unknown> =
      typeof item === 'string' ? { text: item } : item && typeof item === 'object' ? item : {};
    if (o.resolved === true || o.resolved_at != null || o.answered === true) continue;
    const text = String(o.text ?? o.question ?? '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, MAX_QUESTION);
    if (!text) continue;
    let id = clip(o.id, 64) || `q${i + 1}`;
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const options = Array.isArray(o.options)
      ? o.options
          .map((x) => clip(x, MAX_OPTION))
          .filter(Boolean)
          .slice(0, MAX_OPTIONS)
      : [];
    out.push({
      id,
      text,
      options,
      blocking: o.blocking === true || o.blocking === 'true',
      askedAt: parseTs(o.asked_at ?? o.askedAt) ?? fallbackTs,
    });
  }
  return out;
}

/**
 * Decode a status file: UTF-8 (with or without BOM) or UTF-16. Windows PowerShell 5's
 * `'{…}' > file` writes UTF-16LE with a BOM.
 */
export function decodeStatusFile(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const be = buf.subarray(2, 2 + ((buf.length - 2) & ~1));
    return Buffer.from(be).swap16().toString('utf16le');
  }
  // UTF-16LE without BOM: ASCII JSON starts with "{\0" (or whitespace + \0).
  if (buf.length >= 2 && buf.length % 2 === 0 && buf[1] === 0 && buf[0] !== 0) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

/** A `working` status not refreshed within its TTL is shown as possibly stalled. */
export const isStale = (s: AgentStatus, now = Date.now()) =>
  s.state === 'working' && now - s.ts > s.ttl * 1000;

/** POST /api/status is only accepted from this machine. */
export const isLoopback = (addr: string | undefined) =>
  !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));

/** Validate an update from the CLI/HTTP API and write it atomically to the status folder. */
export async function writeStatus(dir: string, input: Record<string, unknown>) {
  const state = String(input.state ?? '').toLowerCase();
  if (!(STATUS_STATES as readonly string[]).includes(state)) {
    throw new Error(`"state" must be one of ${STATUS_STATES.join(', ')}`);
  }
  const agent = input.agent == null || input.agent === '' ? 'agent' : String(input.agent);
  if (!AGENT_RE.test(agent))
    throw new Error('"agent" may only use letters, digits, . _ - (max 64)');
  const body: Record<string, unknown> = { state, agent, ts: new Date().toISOString() };
  if (input.message != null && input.message !== '') {
    body.message = String(input.message).slice(0, MAX_MESSAGE);
  }
  if (input.ttl != null && input.ttl !== '') {
    const ttl = Number(input.ttl);
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error('"ttl" must be a positive number of seconds');
    body.ttl = ttl;
  }
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agent}.json`);
  // Plan and questions survive a plain state update (only replaced when given; null removes).
  let existing: Record<string, unknown> = {};
  try {
    const prev = JSON.parse(decodeStatusFile(await fsp.readFile(file)).replace(/^\uFEFF/, ''));
    if (prev && typeof prev === 'object' && !Array.isArray(prev)) existing = prev;
  } catch {
    // no previous file (or unreadable): nothing to keep
  }
  const pv = 'protocol_version' in input ? input.protocol_version : existing.protocol_version;
  if (pv != null && pv !== '') {
    const n = parseProtocolVersion(pv);
    if (n === undefined) throw new Error('"protocol_version" must be a positive integer');
    body.protocol_version = n;
  }
  for (const key of ['plan', 'step', 'questions'] as const) {
    const v = key in input ? input[key] : existing[key];
    if (v == null) continue;
    if (key !== 'step' && !Array.isArray(v)) throw new Error(`"${key}" must be an array`);
    body[key] = v;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(body) + '\n');
  await fsp.rename(tmp, file);
  return body;
}

interface FileState {
  key: string; // size:mtime of the last read
  status: AgentStatus | null; // last valid status from this file
  error: string | null;
}

/**
 * Watches the status folder (fs.watch for speed plus a 1 s poll for robustness, e.g.
 * on /mnt/c or when the folder is recreated) and reports every change.
 */
export class StatusWatcher {
  readonly dir: string;
  private files = new Map<string, FileState>();
  private timer: NodeJS.Timeout | undefined;
  private fsWatcher: fs.FSWatcher | null = null;
  private scanning: Promise<void> | null = null;
  private again = false;
  private closed = false;
  log: StatusLogEntry[] = [];
  private readonly onChange: (w: StatusWatcher, transitions: StatusLogEntry[]) => void;

  constructor(dir: string, onChange: (w: StatusWatcher, transitions: StatusLogEntry[]) => void) {
    this.dir = dir;
    this.onChange = onChange;
  }

  async start() {
    // Create the folder so `echo '{…}' > <dir>/agent.json` works without a mkdir.
    await fsp.mkdir(this.dir, { recursive: true }).catch(() => {});
    await this.scan(true);
    this.timer = setInterval(() => void this.rescan(), POLL_MS);
    this.watchDir();
  }

  private watchDir() {
    try {
      this.fsWatcher = fs.watch(this.dir, () => void this.rescan());
      this.fsWatcher.on('error', () => {
        this.fsWatcher?.close();
        this.fsWatcher = null; // the poll keeps going; retried on the next scan
      });
    } catch {
      this.fsWatcher = null;
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.fsWatcher?.close();
  }

  rescan(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = this.scan(false).finally(() => {
      this.scanning = null;
      if (this.again && !this.closed) {
        this.again = false;
        void this.rescan();
      }
    });
    return this.scanning;
  }

  /** Re-read files whose size/mtime changed; `initial` sets the baseline without transitions. */
  private async scan(initial: boolean) {
    let names: string[] = [];
    try {
      // Dotfiles are temp files of atomic writers (e.g. `.grok.json.swp`, `.grok.json`).
      names = (await fsp.readdir(this.dir)).filter(
        (n) => n.endsWith('.json') && !n.startsWith('.'),
      );
    } catch {
      names = [];
    }
    if (!this.fsWatcher && !this.closed && !initial && names.length) this.watchDir();
    let changed = false;
    const transitions: StatusLogEntry[] = [];
    const seen = new Set(names);
    for (const name of [...this.files.keys()]) {
      if (!seen.has(name)) {
        this.files.delete(name); // agent file removed: the agent disappears
        changed = true;
      }
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      let st: fs.Stats;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      // The inode changes on an atomic rename, even if size and mtime happen to match.
      const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
      const prev = this.files.get(name);
      if (prev?.key === key) continue;
      const next: FileState = { key, status: prev?.status ?? null, error: null };
      try {
        if (st.size > MAX_FILE_BYTES) throw new Error('file too large');
        const text = decodeStatusFile(await fsp.readFile(file));
        next.status = parseStatus(text, name.slice(0, -5), st.mtimeMs);
      } catch (err) {
        // `echo … > file` truncates first: an empty or half-written file is retried on the next
        // poll instead of flashing a problem; only one that stays broken is reported.
        if (!initial && Math.abs(Date.now() - st.mtimeMs) < SETTLE_MS) {
          continue;
        }
        next.error = (err as Error).message; // keep the last good status, report the problem
      }
      this.files.set(name, next);
      changed = true;
      const s = next.status;
      const old = prev?.status;
      if (s && !next.error && (!old || old.state !== s.state || old.message !== s.message)) {
        // A refresh with the same state and message is not new activity.
        const entry = { agent: s.agent, state: s.state, message: s.message, ts: s.ts };
        if (!initial) this.pushLog(entry);
        if (!initial && (!old || old.state !== s.state)) transitions.push(entry);
      }
      if (s && !next.error && !initial) {
        for (const e of planEvents(old, s)) {
          this.pushLog(e);
          transitions.push(e);
        }
      }
    }
    if (changed && !initial && !this.closed) this.onChange(this, transitions);
  }

  private pushLog(entry: StatusLogEntry) {
    this.log.push(entry);
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  /**
   * The step edits are attributed to right now: the current step of the most recently
   * updated agent that is working and has one. Null when no agent publishes a plan.
   */
  currentStep(): StepRef | null {
    let best: AgentStatus | null = null;
    for (const s of this.agents()) {
      if (s.state !== 'working' || !s.plan || !s.step) continue;
      if (!best || s.ts > best.ts) best = s;
    }
    return best ? stepRef(best) : null;
  }

  /** Current statuses, one per agent (the newest if two files claim the same name). */
  agents(): AgentStatus[] {
    const byAgent = new Map<string, AgentStatus>();
    for (const f of this.files.values()) {
      const s = f.status;
      if (s && (byAgent.get(s.agent)?.ts ?? -1) < s.ts) byAgent.set(s.agent, s);
    }
    return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  }

  problems(): StatusProblem[] {
    return [...this.files.entries()]
      .filter(([, f]) => f.error)
      .map(([file, f]) => ({ file, error: f.error! }));
  }

  snapshot() {
    return {
      dir: this.dir,
      serverTime: Date.now(),
      protocol: PROTOCOL_INFO,
      agents: this.agents().map((s) => ({ ...s, stale: isStale(s) })),
      problems: this.problems(),
      log: this.log,
    };
  }
}

/** Compact reference to a plan step, stored with each edit recorded while it was current. */
export interface StepRef {
  agent: string;
  id: string;
  title: string;
  /** 1-based position in the plan and the plan length, for "2/4" labels. */
  n: number;
  of: number;
}

export function stepRef(s: AgentStatus, id = s.step): StepRef | null {
  if (!s.plan || !id) return null;
  const i = s.plan.findIndex((p) => p.id === id);
  if (i < 0) return null;
  return { agent: s.agent, id, title: s.plan[i].title, n: i + 1, of: s.plan.length };
}

/** Activity entries for a plan/question change between two statuses of one agent. */
export function planEvents(old: AgentStatus | null | undefined, s: AgentStatus): StatusLogEntry[] {
  const out: StatusLogEntry[] = [];
  if (s.step && s.step !== old?.step) {
    const ref = stepRef(s);
    if (ref) {
      out.push({
        agent: s.agent,
        state: s.state,
        message: `Step ${ref.n}/${ref.of}: ${ref.title}`,
        ts: s.ts,
        kind: 'step',
        ref: ref.id,
      });
    }
  }
  const before = new Set((old?.questions ?? []).map((q) => q.id));
  for (const q of s.questions ?? []) {
    if (before.has(q.id)) continue;
    out.push({
      agent: s.agent,
      state: s.state,
      message: `Asked: ${q.text.replace(/\s+/g, ' ').slice(0, MAX_MESSAGE)}`,
      ts: s.ts,
      kind: 'question',
      ref: q.id,
      blocking: q.blocking,
    });
  }
  return out;
}
