// Read-only views of the current branch's git history (first-parent), for the commit browser.
import { computeHunks, type Hunk } from './hunks.ts';
import { instantReason } from '../public/playback-policy.js';
import { git, gitBuffer } from './git.ts';
import { decode, isAlwaysIgnored } from './session.ts';

export const COMMITS_MAX_LIMIT = 200;
/** A commit touching more files than this lists only the first ones. */
export const COMMIT_MAX_FILES = 1000;
/** Abbreviated or full hex object name (sha1 or sha256). Refs/expressions are rejected. */
const SHA_RE = /^[0-9a-f]{4,64}$/i;

export interface CommitMeta {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, epoch ms. */
  date: number;
  subject: string;
}
export interface CommitFile {
  path: string;
  oldPath?: string; // renames / copies
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  binary: boolean;
  plus: number;
  minus: number;
}
export interface CommitDetail extends CommitMeta {
  body: string;
  /** First parent the diff is taken against (null for a root commit). */
  base: string | null;
  files: CommitFile[];
  truncated: boolean;
}

export const isShaLike = (s: unknown): s is string => typeof s === 'string' && SHA_RE.test(s);

const FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%s'].join('%x00');
function parseMeta(rec: string): CommitMeta {
  const [sha, short, parents, author, email, at, subject] = rec.split('\0');
  return {
    sha,
    short,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    date: Number(at) * 1000,
    subject: subject ?? '',
  };
}

/** Resolve a user-supplied sha to a full commit id, or null if it isn't one. */
export async function resolveCommit(root: string, sha: unknown): Promise<string | null> {
  if (!isShaLike(sha)) return null;
  try {
    const full = (await git(['rev-parse', '-q', '--verify', `${sha}^{commit}`], root)).trim();
    return full || null;
  } catch {
    return null;
  }
}

/**
 * First-parent history of HEAD, newest first. With `before`, starts at that commit's
 * first parent (i.e. the next older page). Returns `more` when older commits remain.
 */
export async function listCommits(
  root: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<{ commits: CommitMeta[]; more: boolean }> {
  const limit = Math.max(1, Math.min(COMMITS_MAX_LIMIT, Math.floor(opts.limit ?? 50) || 50));
  let start = 'HEAD';
  if (opts.before) {
    const full = await resolveCommit(root, opts.before);
    if (!full) throw Object.assign(new Error('unknown commit'), { status: 404 });
    const parents = (await git(['rev-list', '--parents', '-n', '1', full], root)).trim().split(' ');
    if (parents.length < 2) return { commits: [], more: false }; // root commit
    start = parents[1];
  } else {
    try {
      await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], root);
    } catch {
      return { commits: [], more: false }; // unborn branch
    }
  }
  const out = await git(
    ['log', '--first-parent', `-n${limit + 1}`, `--format=${FORMAT}%x1e`, start, '--'],
    root,
  );
  const commits = out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map(parseMeta);
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

const STATUS: Record<string, CommitFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

/** Diff-tree args: first parent → commit, or the whole tree for a root commit. */
const treeArgs = (full: string, base: string | null) => (base ? [base, full] : ['--root', full]);

export async function commitDetail(root: string, full: string): Promise<CommitDetail> {
  const raw = await git(['show', '-s', `--format=${FORMAT}%x00%b`, full], root);
  const parts = raw.split('\0');
  const meta = parseMeta(parts.slice(0, 7).join('\0'));
  const body = (parts[7] ?? '').trim();
  const base = meta.parents[0] ?? null;
  const common = ['diff-tree', '-r', '-M', '--no-commit-id', '-z'];
  const [names, nums] = await Promise.all([
    git([...common, '--name-status', ...treeArgs(full, base)], root),
    git([...common, '--numstat', ...treeArgs(full, base)], root),
  ]);
  const files: CommitFile[] = [];
  const n = names.split('\0');
  for (let i = 0; i < n.length && n[i];) {
    const code = n[i++];
    const kind = STATUS[code[0]] ?? 'modified';
    if (kind === 'renamed' || kind === 'copied') {
      files.push({ oldPath: n[i], path: n[i + 1], status: kind, binary: false, plus: 0, minus: 0 });
      i += 2;
    } else {
      files.push({ path: n[i++], status: kind, binary: false, plus: 0, minus: 0 });
    }
  }
  // numstat -z: "plus\tminus\tpath\0" or, for renames, "plus\tminus\t\0old\0new\0".
  const s = nums.split('\0');
  for (let i = 0, k = 0; i < s.length && s[i] && k < files.length; k++) {
    const [plus, minus, p] = s[i++].split('\t');
    if (!p) i += 2;
    const f = files[k];
    f.binary = plus === '-';
    f.plus = f.binary ? 0 : Number(plus);
    f.minus = f.binary ? 0 : Number(minus);
  }
  const visible = files.filter((f) => !isAlwaysIgnored(f.path));
  return {
    ...meta,
    body,
    base,
    files: visible.slice(0, COMMIT_MAX_FILES),
    truncated: visible.length > COMMIT_MAX_FILES,
  };
}

async function readAt(root: string, rev: string | null, rel: string | undefined) {
  if (!rev || !rel) return { text: null, binary: false };
  try {
    return decode(await gitBuffer(['show', `${rev}:${rel}`], root));
  } catch {
    return { text: null, binary: false };
  }
}

/** One file of a commit as a playback event (same shape as a live change event). */
export async function commitFileEvent(root: string, detail: CommitDetail, rel: string) {
  const f = detail.files.find((x) => x.path === rel);
  if (!f) return null;
  const [prev, next] = await Promise.all([
    readAt(root, detail.base, f.status === 'added' ? undefined : (f.oldPath ?? f.path)),
    readAt(root, detail.sha, f.status === 'deleted' ? undefined : f.path),
  ]);
  const binary = f.binary || prev.binary || next.binary;
  const before = binary ? '' : (prev.text ?? '');
  const after = binary ? '' : (next.text ?? '');
  const hunks: Hunk[] = binary ? [] : computeHunks(before, after);
  return {
    type: 'commit-file',
    sha: detail.sha,
    path: f.path,
    oldPath: f.oldPath,
    status: f.status === 'added' ? 'created' : f.status === 'deleted' ? 'deleted' : 'modified',
    fileStatus: f.status,
    ts: detail.date,
    binary,
    before,
    after,
    hunks,
    instant: binary ? 'binary' : instantReason(f.path, hunks),
  };
}
