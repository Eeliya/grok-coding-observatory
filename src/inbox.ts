// Human → agent chat through an inbox file per agent: <git dir>/observatory/inbox/<agent>.jsonl.
// Agents act in steps (no websockets): they run `grok-observatory inbox` between steps, which
// prints unread messages and appends a read receipt, and `grok-observatory reply "…"` to answer.
// One JSON object per line:
//   {"type":"message","id":"h-…","ts":"<ISO>","from":"human"|"agent","text":"…","re":"q1"?}
//   {"type":"read","ids":["h-…"],"ts":"<ISO>"}            (written by the agent's `inbox`)
// Append-only, so the server and the CLI never rewrite each other's lines.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { git } from './git.ts';
import { AGENT_RE } from './status.ts';

export const MAX_CHAT_TEXT = 4000;
/** Appends are refused beyond this size; the thread view only keeps the newest messages. */
export const MAX_INBOX_BYTES = 2 * 1024 * 1024;
const THREAD_MAX = 200;
const POLL_MS = 1000;
export const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type ChatFrom = 'human' | 'agent';
export interface ChatMessage {
  id: string;
  ts: number;
  from: ChatFrom;
  text: string;
  re?: string;
  /** Human messages: the agent has fetched it with `inbox`. */
  seen?: boolean;
}

/** Absolute inbox folder of the work tree at `cwd` (next to the status folder). */
export async function inboxDir(cwd: string): Promise<string> {
  const out = await git(
    ['rev-parse', '--path-format=absolute', '--git-path', 'observatory/inbox'],
    cwd,
  );
  return out.trim();
}

const parseTs = (v: unknown) => {
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) && t > 0 ? t : 0;
};

/** Parse an inbox file leniently (bad lines are skipped). Newest THREAD_MAX messages. */
export function parseInbox(text: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const read = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    if (d.type === 'read' && Array.isArray(d.ids)) {
      for (const id of d.ids) read.add(String(id));
    } else if (d.type === 'message' && typeof d.text === 'string' && d.id != null) {
      const from: ChatFrom = d.from === 'agent' ? 'agent' : 'human';
      const m: ChatMessage = {
        id: String(d.id),
        ts: parseTs(d.ts),
        from,
        text: d.text.slice(0, MAX_CHAT_TEXT),
      };
      if (typeof d.re === 'string' && REF_RE.test(d.re)) m.re = d.re;
      messages.push(m);
    }
  }
  for (const m of messages) if (m.from === 'human') m.seen = read.has(m.id);
  return messages.slice(-THREAD_MAX);
}

/** Validate and append a message; returns it. Throws with a readable reason (HTTP 400/413). */
export async function appendMessage(
  dir: string,
  input: { agent?: unknown; text?: unknown; re?: unknown },
  from: ChatFrom = 'human',
): Promise<ChatMessage & { agent: string }> {
  const agent = String(input.agent ?? '');
  if (!AGENT_RE.test(agent))
    throw new Error('"agent" may only use letters, digits, . _ - (max 64)');
  if (typeof input.text !== 'string') throw new Error('"text" must be a string');
  const text = input.text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('"text" is empty');
  if (text.length > MAX_CHAT_TEXT)
    throw Object.assign(new Error(`"text" is longer than ${MAX_CHAT_TEXT} characters`), {
      status: 413,
    });
  const re = input.re == null || input.re === '' ? undefined : String(input.re);
  if (re !== undefined && !REF_RE.test(re)) throw new Error('"re" must be a question id');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agent}.jsonl`);
  const size = await fsp.stat(file).then(
    (s) => s.size,
    () => 0,
  );
  if (size > MAX_INBOX_BYTES)
    throw Object.assign(new Error('inbox file is full (over 2 MB); archive or delete it'), {
      status: 413,
    });
  const ts = Date.now();
  const id = `${from === 'human' ? 'h' : 'a'}-${ts.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const line: Record<string, unknown> = {
    type: 'message',
    id,
    ts: new Date(ts).toISOString(),
    from,
    text,
  };
  if (re) line.re = re;
  // O_APPEND: one small write per line, so concurrent appends never interleave.
  await fsp.appendFile(file, JSON.stringify(line) + '\n');
  return {
    agent,
    id,
    ts,
    from,
    text,
    ...(re ? { re } : {}),
    ...(from === 'human' ? { seen: false } : {}),
  };
}

/** Watches the inbox folder (fs.watch + 1 s poll, like the status folder). */
export class InboxWatcher {
  readonly dir: string;
  private files = new Map<string, { key: string; messages: ChatMessage[] }>();
  private timer: NodeJS.Timeout | undefined;
  private fsWatcher: fs.FSWatcher | null = null;
  private scanning: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly onChange: (w: InboxWatcher) => void;

  constructor(dir: string, onChange: (w: InboxWatcher) => void) {
    this.dir = dir;
    this.onChange = onChange;
  }

  async start() {
    await fsp.mkdir(this.dir, { recursive: true }).catch(() => {});
    await this.scan(true);
    this.timer = setInterval(() => void this.rescan(), POLL_MS);
    this.watch();
  }

  private watch() {
    try {
      this.fsWatcher = fs.watch(this.dir, () => void this.rescan());
      this.fsWatcher.on('error', () => {
        this.fsWatcher?.close();
        this.fsWatcher = null;
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

  private async scan(initial: boolean) {
    let names: string[] = [];
    try {
      names = (await fsp.readdir(this.dir)).filter(
        (n) => n.endsWith('.jsonl') && !n.startsWith('.') && AGENT_RE.test(n.slice(0, -6)),
      );
    } catch {
      names = [];
    }
    if (!this.fsWatcher && !this.closed && !initial) this.watch();
    let changed = false;
    const seen = new Set(names);
    for (const name of [...this.files.keys()]) {
      if (!seen.has(name)) {
        this.files.delete(name);
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
      const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (this.files.get(name)?.key === key) continue;
      let text = '';
      try {
        const fd = await fsp.open(file, 'r');
        try {
          // Huge files: only the tail matters for the thread view.
          const start = Math.max(0, st.size - MAX_INBOX_BYTES);
          const buf = Buffer.alloc(st.size - start);
          await fd.read(buf, 0, buf.length, start);
          text = buf.toString('utf8');
          if (start > 0) text = text.slice(text.indexOf('\n') + 1);
        } finally {
          await fd.close();
        }
      } catch {
        continue;
      }
      this.files.set(name, { key, messages: parseInbox(text) });
      changed = true;
    }
    if (changed && !initial && !this.closed) this.onChange(this);
  }

  /** { agent: messages } for every inbox file. */
  threads(): Record<string, ChatMessage[]> {
    const out: Record<string, ChatMessage[]> = {};
    for (const [name, f] of this.files) out[name.slice(0, -6)] = f.messages;
    return out;
  }

  snapshot() {
    return { dir: this.dir, threads: this.threads() };
  }
}
