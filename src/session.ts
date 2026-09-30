// One watched git work tree: file watcher, snapshots, HEAD tracking and change events.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import { computeHunks, type Hunk } from './hunks.ts';
import { instantReason } from '../public/playback-policy.js';
import { git, gitBuffer, GIT_ENV, execFileP } from './git.ts';

const MAX_FILE_BYTES = 1024 * 1024;
/** Files above this are identified by size + mtime instead of a content hash. */
const HASH_MAX_BYTES = 8 * 1024 * 1024;
const DEBOUNCE_MS = 60;
const HEAD_POLL_MS = 2000;
const ALWAYS_IGNORED = new Set(['node_modules', '.git', 'dist']);

interface Content {
  text: string | null; // null = missing (or binary)
  binary: boolean;
}
type FileStatus = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed';
type FileCategory = 'changed' | 'untracked';
export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** "changed" = tracked file differing from HEAD / index; "untracked" = new, not ignored. */
  category: FileCategory;
  /** Epoch ms of the last live edit seen by this server (absent if not edited live). */
  editedAt?: number;
  /** Content identity (sha1, or "m:size:mtime" for huge files, "deleted" if gone). */
  hash?: string;
}
export interface HeadInfo {
  branch: string | null; // null when detached
  sha: string | null; // short sha; null before the first commit
  detached: boolean;
}
export interface ChangeEvent {
  type: 'change';
  id: number;
  ts: number;
  path: string;
  status: 'created' | 'deleted' | 'modified';
  binary: boolean;
  before: string;
  after: string;
  hunks: Hunk[];
  /** Content identity of `after` (same scheme as ChangedFile.hash). */
  hash: string;
  /** Set when the change should be shown instantly instead of typed. */
  instant: 'generated' | 'large' | 'binary' | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAlwaysIgnored = (rel: string) => rel.split('/').some((seg) => ALWAYS_IGNORED.has(seg));

function decode(buf: Buffer | null): Content {
  if (buf == null) return { text: null, binary: false };
  if (buf.length > MAX_FILE_BYTES || buf.includes(0)) return { text: null, binary: true };
  return { text: buf.toString('utf8'), binary: false };
}

export function safeRel(rel: string | null): string | null {
  if (!rel) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) return null;
  return norm;
}

export const describeHead = (h: HeadInfo) =>
  h.detached ? `detached@${h.sha ?? '?'}` : `${h.branch}@${h.sha ?? 'unborn'}`;

export interface SessionOptions {
  target: string; // watched directory (may be a sub-directory of the repo)
  root: string; // git top-level
  gitDir: string; // absolute .git directory
  emit: (msg: object) => void; // broadcast to clients
  nextId: () => number; // global, monotonically increasing event id
}

export class Session {
  readonly target: string;
  readonly root: string;
  private readonly gitDir: string;
  private readonly emit: (msg: object) => void;
  private readonly nextId: () => number;

  head: HeadInfo = { branch: null, sha: null, detached: false };
  files: ChangedFile[] = [];
  private hasHead = false;
  private closed = false;
  private watcher: FSWatcher | null = null;
  private headPoll: NodeJS.Timeout | undefined;
  private filesTimer: NodeJS.Timeout | undefined;
  private ignoredDirs: string[] = [];
  private ignoredFiles = new Set<string>();
  /** Last live edit per repo-relative path (drives the "recently edited" marker). */
  private lastEdited = new Map<string, number>();
  /** Last known content per repo-relative path. */
  private snapshots = new Map<string, Content>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  /** Serial queue: events keep their order and each diff starts where the last ended. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: SessionOptions) {
    this.target = opts.target;
    this.root = opts.root;
    this.gitDir = opts.gitDir;
    this.emit = opts.emit;
    this.nextId = opts.nextId;
  }

  // ------------------------------------------------------------ lifecycle

  async start() {
    this.head = await this.readHeadInfo();
    this.hasHead = this.head.sha !== null;
    await this.loadIgnored();
    this.files = await this.getChangedFiles();
    // Files already dirty at start begin from their current content, so the first
    // replayed event shows only the new edit rather than the whole diff vs HEAD.
    for (const f of this.files) this.snapshots.set(f.path, await this.readWorking(f.path));

    const watcher = chokidar.watch(this.target, {
      ignoreInitial: true,
      ignored: (p: string) => this.isIgnoredPath(p),
    });
    this.watcher = watcher;
    const schedule = (abs: string) => this.schedule(abs);
    const refresh = () => this.scheduleFilesRefresh();
    watcher
      .on('add', schedule)
      .on('change', schedule)
      .on('unlink', schedule)
      .on('addDir', refresh)
      .on('unlinkDir', refresh)
      .on('error', (err) => console.error('Watcher error:', err));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

    // Cheap HEAD poll catches commits/checkouts that touch no watched files.
    this.headPoll = setInterval(() => {
      this.enqueue(async () => {
        await this.waitForGitIdle();
        await this.syncHead();
      });
    }, HEAD_POLL_MS);
  }

  async close() {
    this.closed = true;
    clearInterval(this.headPoll);
    clearTimeout(this.filesTimer);
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    await this.watcher?.close();
  }

  private enqueue(job: () => Promise<unknown>) {
    this.chain = this.chain
      .then(async () => {
        if (!this.closed) await job();
      })
      .catch((err) => console.error('Observatory job failed:', err));
  }

  private send(msg: object) {
    if (!this.closed) this.emit(msg);
  }

  // ------------------------------------------------------------ git reads

  private git(args: string[]) {
    return git(args, this.target);
  }

  private async readHeadInfo(): Promise<HeadInfo> {
    const [branch, sha] = await Promise.all([
      this.git(['symbolic-ref', '-q', '--short', 'HEAD']).then(
        (s) => s.trim() || null,
        () => null,
      ),
      this.git(['rev-parse', '-q', '--verify', '--short', 'HEAD']).then(
        (s) => s.trim() || null,
        () => null,
      ),
    ]);
    return { branch, sha, detached: branch === null };
  }

  async readHead(rel: string): Promise<Content> {
    if (!this.hasHead) return { text: null, binary: false };
    try {
      return decode(await gitBuffer(['show', `HEAD:${rel}`], this.root));
    } catch {
      return { text: null, binary: false }; // not in HEAD
    }
  }

  private hashCache = new Map<string, { key: string; hash: string }>();

  /** Content identity of the working-tree file (cached by size + mtime). */
  async fileHash(rel: string): Promise<string> {
    const abs = path.join(this.root, rel);
    let st: fs.Stats;
    try {
      st = await fsp.stat(abs);
    } catch {
      return 'deleted';
    }
    if (!st.isFile()) return 'dir';
    const key = `${st.size}:${st.mtimeMs}`;
    const cached = this.hashCache.get(rel);
    if (cached?.key === key) return cached.hash;
    let hash: string;
    if (st.size > HASH_MAX_BYTES) hash = `m:${key}`;
    else {
      try {
        hash = createHash('sha1')
          .update(await fsp.readFile(abs))
          .digest('hex');
      } catch {
        return 'deleted';
      }
    }
    this.hashCache.set(rel, { key, hash });
    return hash;
  }

  async readWorking(rel: string): Promise<Content> {
    try {
      return decode(await fsp.readFile(path.join(this.root, rel)));
    } catch {
      return { text: null, binary: false }; // missing
    }
  }

  private async isGitIgnored(rel: string): Promise<boolean> {
    try {
      await execFileP('git', ['check-ignore', '-q', '--', rel], { cwd: this.root, env: GIT_ENV });
      return true; // exit 0 => ignored
    } catch {
      return false;
    }
  }

  /** Ignored paths (collapsed to directories) so chokidar never descends into them. */
  private async loadIgnored() {
    try {
      const out = await git(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        this.root,
      );
      const dirs: string[] = [];
      const files = new Set<string>();
      for (const entry of out.split('\0')) {
        if (!entry) continue;
        if (entry.endsWith('/')) dirs.push(entry.slice(0, -1));
        else files.add(entry);
      }
      this.ignoredDirs = dirs;
      this.ignoredFiles = files;
    } catch (err) {
      console.warn('Could not list ignored files:', (err as Error).message);
    }
  }

  private toRel(abs: string) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  private isIgnoredPath(abs: string): boolean {
    const rel = this.toRel(abs);
    if (!rel || rel.startsWith('..')) return false;
    if (isAlwaysIgnored(rel) || this.ignoredFiles.has(rel)) return true;
    return this.ignoredDirs.some((d) => rel === d || rel.startsWith(d + '/'));
  }

  // ------------------------------------------------------------ changed files

  private async getChangedFiles(): Promise<ChangedFile[]> {
    const out = await this.git([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ]);
    const parts = out.split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (!entry) continue;
      const xy = entry.slice(0, 2);
      const file = entry.slice(3);
      let status: FileStatus;
      if (xy[0] === 'R' || xy[0] === 'C') {
        i++; // skip the original path
        status = 'renamed';
      } else if (xy === '??') status = 'untracked';
      else if (xy.includes('D')) status = 'deleted';
      else if (xy.includes('A')) status = 'added';
      else status = 'modified';
      // --untracked-files=all already expands untracked dirs; a trailing "/" only
      // remains for nested repositories, which we show as a single entry.
      const clean = file.endsWith('/') ? file.slice(0, -1) : file;
      if (isAlwaysIgnored(clean)) continue;
      const item: ChangedFile = {
        path: clean,
        status,
        category: status === 'untracked' ? 'untracked' : 'changed',
      };
      const editedAt = this.lastEdited.get(clean);
      if (editedAt) item.editedAt = editedAt;
      files.push(item);
    }
    // "changed" first, then "untracked"; alphabetical within each group.
    files.sort(
      (a, b) =>
        Number(a.category === 'untracked') - Number(b.category === 'untracked') ||
        a.path.localeCompare(b.path),
    );
    await Promise.all(
      files.map(async (f) => {
        f.hash = await this.fileHash(f.path);
      }),
    );
    return files;
  }

  private scheduleFilesRefresh() {
    clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(async () => {
      try {
        const files = await this.getChangedFiles();
        if (!this.closed && JSON.stringify(files) !== JSON.stringify(this.files)) {
          this.files = files;
          this.send({ type: 'files', files });
        }
      } catch (err) {
        if (!this.closed) console.error('git status failed:', (err as Error).message);
      }
    }, 150);
  }

  // ------------------------------------------------------------ change events

  private schedule(abs: string) {
    const rel = this.toRel(abs);
    if (!rel || rel.startsWith('..') || this.closed) return;
    clearTimeout(this.pendingTimers.get(rel));
    this.pendingTimers.set(
      rel,
      setTimeout(() => {
        this.pendingTimers.delete(rel);
        this.enqueue(() => this.processFile(rel));
      }, DEBOUNCE_MS),
    );
  }

  private async processFile(rel: string) {
    if (isAlwaysIgnored(rel)) return;
    // A checkout/reset/commit rewrites files: let git finish, and if HEAD moved,
    // treat everything as a reset instead of replaying it as typing.
    await this.waitForGitIdle();
    if (await this.syncHead()) return;
    if (await this.isGitIgnored(rel)) return;
    const prev = this.snapshots.get(rel) ?? (await this.readHead(rel));
    const next = await this.readWorking(rel);
    this.snapshots.set(rel, next);
    this.scheduleFilesRefresh();

    if (!prev.binary && !next.binary && prev.text === next.text) return;
    const binary = prev.binary || next.binary;
    const before = prev.text ?? '';
    const after = next.text ?? '';
    const event: ChangeEvent = {
      type: 'change',
      id: this.nextId(),
      ts: Date.now(),
      path: rel,
      status:
        prev.text == null && !prev.binary
          ? 'created'
          : next.text == null && !next.binary
            ? 'deleted'
            : 'modified',
      binary,
      before: binary ? '' : before,
      after: binary ? '' : after,
      hunks: binary ? [] : computeHunks(before, after),
      instant: null,
      hash: await this.fileHash(rel),
    };
    event.instant = binary ? 'binary' : instantReason(rel, event.hunks);
    this.lastEdited.set(rel, event.ts);
    this.scheduleFilesRefresh();
    const n = event.hunks.length;
    console.log(
      `[${new Date().toLocaleTimeString()}] #${event.id} ${event.status} ${rel} (${n} hunk${n === 1 ? '' : 's'}${event.instant ? `, instant: ${event.instant}` : ''})`,
    );
    this.send(event);
  }

  /** Wait while git holds its index/HEAD locks (checkout, reset, commit, …). */
  private async waitForGitIdle() {
    const locks = ['index.lock', 'HEAD.lock'].map((f) => path.join(this.gitDir, f));
    let waited = false;
    for (let i = 0; i < 200 && locks.some((l) => fs.existsSync(l)); i++) {
      waited = true;
      await sleep(50);
    }
    if (waited) await sleep(50); // HEAD is written right after the index lock is released
  }

  /**
   * Compare HEAD with what we know; on a branch switch or HEAD move, rebuild the
   * baselines from the new HEAD + working tree and tell clients to reset.
   * Returns true when a reset happened. Runs inside the serial queue.
   */
  private async syncHead(): Promise<boolean> {
    const next = await this.readHeadInfo();
    if (next.branch === this.head.branch && next.sha === this.head.sha) return false;
    const prev = this.head;
    this.head = next;
    this.hasHead = next.sha !== null;
    for (const t of this.pendingTimers.values()) clearTimeout(t); // checkout artefacts
    this.pendingTimers.clear();
    await this.loadIgnored();
    this.snapshots.clear();
    this.lastEdited.clear();
    this.files = await this.getChangedFiles();
    for (const f of this.files) this.snapshots.set(f.path, await this.readWorking(f.path));
    const reason = prev.branch !== next.branch ? 'branch' : 'head';
    console.log(
      `[${new Date().toLocaleTimeString()}] HEAD ${describeHead(prev)} -> ${describeHead(next)} (reset, no replay)`,
    );
    this.send({ type: 'reset', reason, ...this.info() });
    return true;
  }

  info() {
    return { target: this.target, root: this.root, head: this.head, files: this.files };
  }
}
