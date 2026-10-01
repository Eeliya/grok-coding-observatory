// Agent status protocol: agents drop small JSON files into <git dir>/observatory/status/
// (one per agent); this module parses them and watches the folder. See docs/AGENT-PROTOCOL.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.ts';

export const STATUS_STATES = ['working', 'done', 'idle'] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export const DEFAULT_TTL_S = 600;
export const MAX_MESSAGE = 200;
const MAX_FILE_BYTES = 16 * 1024;
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
}
export interface StatusProblem {
  file: string;
  error: string;
}
export interface StatusLogEntry {
  agent: string;
  state: StatusState;
  message: string;
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
  return {
    agent,
    state: state as StatusState,
    message:
      typeof d.message === 'string'
        ? d.message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
        : '',
    ts: parseTs(d.ts) ?? mtimeMs,
    ttl: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 7 * 24 * 3600) : DEFAULT_TTL_S,
  };
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
        if (!initial) {
          this.log.push(entry);
          if (this.log.length > LOG_MAX) this.log.shift();
        }
        if (!initial && (!old || old.state !== s.state)) transitions.push(entry);
      }
    }
    if (changed && !initial && !this.closed) this.onChange(this, transitions);
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
      agents: this.agents().map((s) => ({ ...s, stale: isStale(s) })),
      problems: this.problems(),
      log: this.log,
    };
  }
}
