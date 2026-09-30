// Grok Coding Observatory — watches a git project and streams file edits to the browser.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';
import { computeHunks, type Hunk } from './hunks.ts';
import { instantReason } from '../public/playback-policy.js';

const execFileP = promisify(execFile);
// Never take optional locks (e.g. `git status` refreshing the index), so the
// observatory can't interfere with the user's own git commands.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = process.env.PORT === undefined ? 4477 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_FILE_BYTES = 1024 * 1024;
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
  /** Set when the change should be shown instantly instead of typed. */
  instant: 'generated' | 'large' | 'binary' | null;
}

const targetArg = process.argv[2] || process.env.TARGET_DIR;
if (!targetArg) {
  console.error('Usage: npm start -- /path/to/project   (or set TARGET_DIR)');
  process.exit(1);
}
const TARGET = path.resolve(targetArg);
if (!fs.existsSync(TARGET) || !fs.statSync(TARGET).isDirectory()) {
  console.error(`Target directory does not exist: ${TARGET}`);
  process.exit(1);
}

async function git(args: string[], cwd = TARGET): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: GIT_ENV,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}
async function gitBuffer(args: string[], cwd = TARGET): Promise<Buffer> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: GIT_ENV,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
  return stdout;
}

let ROOT: string;
try {
  ROOT = (await git(['rev-parse', '--show-toplevel'])).trim();
} catch {
  console.error(`Not inside a git repository: ${TARGET}`);
  process.exit(1);
}

const GIT_DIR = (await git(['rev-parse', '--absolute-git-dir'])).trim();

async function readHeadInfo(): Promise<HeadInfo> {
  const [branch, sha] = await Promise.all([
    git(['symbolic-ref', '-q', '--short', 'HEAD']).then(
      (s) => s.trim() || null,
      () => null,
    ),
    git(['rev-parse', '-q', '--verify', '--short', 'HEAD']).then(
      (s) => s.trim() || null,
      () => null,
    ),
  ]);
  return { branch, sha, detached: branch === null };
}

let head: HeadInfo = await readHeadInfo();
let hasHead = head.sha !== null;

// ---------------------------------------------------------------- helpers

const toRel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
const isAlwaysIgnored = (rel: string) => rel.split('/').some((seg) => ALWAYS_IGNORED.has(seg));

function safeRel(rel: string | null): string | null {
  if (!rel) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) return null;
  return norm;
}

function decode(buf: Buffer | null): Content {
  if (buf == null) return { text: null, binary: false };
  if (buf.length > MAX_FILE_BYTES || buf.includes(0)) return { text: null, binary: true };
  return { text: buf.toString('utf8'), binary: false };
}

async function readHead(rel: string): Promise<Content> {
  if (!hasHead) return { text: null, binary: false };
  try {
    return decode(await gitBuffer(['show', `HEAD:${rel}`], ROOT));
  } catch {
    return { text: null, binary: false }; // not in HEAD
  }
}

async function readWorking(rel: string): Promise<Content> {
  try {
    return decode(await fsp.readFile(path.join(ROOT, rel)));
  } catch {
    return { text: null, binary: false }; // missing
  }
}

async function isGitIgnored(rel: string): Promise<boolean> {
  try {
    await execFileP('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT, env: GIT_ENV });
    return true; // exit 0 => ignored
  } catch {
    return false;
  }
}

// Ignored paths (collapsed to directories) so chokidar never descends into them.
let ignoredDirs: string[] = [];
let ignoredFiles = new Set<string>();
async function loadIgnored() {
  try {
    const out = await git(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      ROOT,
    );
    const dirs: string[] = [];
    const files = new Set<string>();
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      if (entry.endsWith('/')) dirs.push(entry.slice(0, -1));
      else files.add(entry);
    }
    ignoredDirs = dirs;
    ignoredFiles = files;
  } catch (err) {
    console.warn('Could not list ignored files:', (err as Error).message);
  }
}

function isIgnoredPath(abs: string): boolean {
  const rel = toRel(abs);
  if (!rel || rel.startsWith('..')) return false;
  if (isAlwaysIgnored(rel) || ignoredFiles.has(rel)) return true;
  return ignoredDirs.some((d) => rel === d || rel.startsWith(d + '/'));
}

// ---------------------------------------------------------------- changed files

// Last live edit per repo-relative path (drives the "recently edited" marker).
const lastEdited = new Map<string, number>();

async function getChangedFiles(): Promise<ChangedFile[]> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
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
    const editedAt = lastEdited.get(clean);
    if (editedAt) item.editedAt = editedAt;
    files.push(item);
  }
  // "changed" first, then "untracked"; alphabetical within each group.
  files.sort(
    (a, b) =>
      Number(a.category === 'untracked') - Number(b.category === 'untracked') ||
      a.path.localeCompare(b.path),
  );
  return files;
}

let filesCache: ChangedFile[] = [];
let filesTimer: NodeJS.Timeout | undefined;
function scheduleFilesRefresh() {
  clearTimeout(filesTimer);
  filesTimer = setTimeout(async () => {
    try {
      const files = await getChangedFiles();
      if (JSON.stringify(files) !== JSON.stringify(filesCache)) {
        filesCache = files;
        broadcast({ type: 'files', files });
      }
    } catch (err) {
      console.error('git status failed:', (err as Error).message);
    }
  }, 150);
}

// ---------------------------------------------------------------- change events

// Last known content per repo-relative path.
const snapshots = new Map<string, Content>();
let eventId = 0;

async function processFile(rel: string) {
  if (isAlwaysIgnored(rel)) return;
  // A checkout/reset/commit rewrites files: let git finish, and if HEAD moved,
  // treat everything as a reset instead of replaying it as typing.
  await waitForGitIdle();
  if (await syncHead()) return;
  if (await isGitIgnored(rel)) return;
  const prev = snapshots.get(rel) ?? (await readHead(rel));
  const next = await readWorking(rel);
  snapshots.set(rel, next);
  scheduleFilesRefresh();

  if (!prev.binary && !next.binary && prev.text === next.text) return;
  const binary = prev.binary || next.binary;
  const before = prev.text ?? '';
  const after = next.text ?? '';
  const event: ChangeEvent = {
    type: 'change',
    id: ++eventId,
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
  };
  event.instant = binary ? 'binary' : instantReason(rel, event.hunks);
  lastEdited.set(rel, event.ts);
  scheduleFilesRefresh();
  const n = event.hunks.length;
  console.log(
    `[${new Date().toLocaleTimeString()}] #${event.id} ${event.status} ${rel} (${n} hunk${n === 1 ? '' : 's'}${event.instant ? `, instant: ${event.instant}` : ''})`,
  );
  broadcast(event);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait while git holds its index/HEAD locks (checkout, reset, commit, …). */
async function waitForGitIdle() {
  const locks = ['index.lock', 'HEAD.lock'].map((f) => path.join(GIT_DIR, f));
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
 * Returns true when a reset happened. Must run inside `chain`.
 */
async function syncHead(): Promise<boolean> {
  const next = await readHeadInfo();
  if (next.branch === head.branch && next.sha === head.sha) return false;
  const prev = head;
  head = next;
  hasHead = next.sha !== null;
  for (const t of pendingTimers.values()) clearTimeout(t); // checkout artefacts
  pendingTimers.clear();
  await loadIgnored();
  snapshots.clear();
  lastEdited.clear();
  filesCache = await getChangedFiles();
  for (const f of filesCache) snapshots.set(f.path, await readWorking(f.path));
  const reason = prev.branch !== next.branch ? 'branch' : 'head';
  console.log(
    `[${new Date().toLocaleTimeString()}] HEAD ${describeHead(prev)} -> ${describeHead(next)} (reset, no replay)`,
  );
  broadcast({ type: 'reset', reason, head, files: filesCache });
  return true;
}

const describeHead = (h: HeadInfo) =>
  h.detached ? `detached@${h.sha ?? '?'}` : `${h.branch}@${h.sha ?? 'unborn'}`;

// Per-file debounce, then one serial queue so events keep their order and each
// diff starts exactly where the previous one ended (nothing is dropped).
const pendingTimers = new Map<string, NodeJS.Timeout>();
let chain: Promise<void> = Promise.resolve();
function schedule(abs: string) {
  const rel = toRel(abs);
  if (!rel || rel.startsWith('..')) return;
  clearTimeout(pendingTimers.get(rel));
  pendingTimers.set(
    rel,
    setTimeout(() => {
      pendingTimers.delete(rel);
      chain = chain
        .then(() => processFile(rel))
        .catch((err) => console.error(`Failed to process ${rel}:`, err));
    }, DEBOUNCE_MS),
  );
}

// ---------------------------------------------------------------- http + ws

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/files') {
      return sendJson(res, 200, { target: TARGET, root: ROOT, head, files: filesCache });
    }
    if (url.pathname === '/api/diff') {
      const rel = safeRel(url.searchParams.get('path'));
      if (!rel) return sendJson(res, 400, { error: 'invalid path' });
      const [head, current] = await Promise.all([readHead(rel), readWorking(rel)]);
      return sendJson(res, 200, {
        path: rel,
        binary: head.binary || current.binary,
        head: head.text,
        current: current.text,
      });
    }
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const abs = path.resolve(PUBLIC_DIR, file);
    if (!abs.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') res.writeHead(404).end('Not found');
    else {
      console.error(err);
      res.writeHead(500).end('Internal error');
    }
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', target: TARGET, root: ROOT, head }));
  ws.send(JSON.stringify({ type: 'files', files: filesCache }));
});

// ---------------------------------------------------------------- startup

await loadIgnored();
filesCache = await getChangedFiles();
// Files already dirty at startup begin from their current content, so the first
// replayed event shows only the new edit rather than the whole diff vs HEAD.
for (const f of filesCache) snapshots.set(f.path, await readWorking(f.path));

const watcher = chokidar.watch(TARGET, {
  ignoreInitial: true,
  ignored: (p: string) => isIgnoredPath(p),
});
watcher
  .on('add', schedule)
  .on('change', schedule)
  .on('unlink', schedule)
  .on('addDir', scheduleFilesRefresh)
  .on('unlinkDir', scheduleFilesRefresh)
  .on('error', (err) => console.error('Watcher error:', err));
await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

// Cheap HEAD poll (two tiny git commands) catches commits/checkouts that touch no files.
const headPoll = setInterval(() => {
  chain = chain
    .then(async () => {
      await waitForGitIdle();
      await syncHead();
    })
    .catch((err) => console.error('HEAD check failed:', err));
}, HEAD_POLL_MS);

server.listen(PORT, HOST, () => {
  const { port } = server.address() as AddressInfo;
  const shownHost = HOST === '0.0.0.0' || HOST === '127.0.0.1' ? 'localhost' : HOST;
  console.log(`Coding Observatory watching ${TARGET}`);
  console.log(`${describeHead(head)} · ${filesCache.length} changed file(s) vs HEAD`);
  console.log(`Open http://${shownHost}:${port}`);
});

function shutdown() {
  clearInterval(headPoll);
  void watcher.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
