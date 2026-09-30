// Repo selection: validation, recent/last-used persistence and discovery under ~/work.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.ts';

const MAX_RECENT = 10;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'target']);

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export const CONFIG_DIR =
  (process.env.OBSERVATORY_CONFIG_DIR && expandHome(process.env.OBSERVATORY_CONFIG_DIR)) ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'grok-coding-observatory',
  );
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
export const REPOS_ROOT = expandHome(process.env.REPOS_ROOT || '~/work');
export const SCAN_DEPTH = 2;

export interface RecentRepo {
  path: string;
  usedAt: number;
}
interface State {
  lastRepo: string | null;
  recent: RecentRepo[];
}

export interface RepoRef {
  target: string; // directory to watch
  root: string; // git top-level
  gitDir: string; // absolute git dir
}

export async function loadState(): Promise<State> {
  try {
    const data = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    return {
      lastRepo: typeof data.lastRepo === 'string' ? data.lastRepo : null,
      recent: Array.isArray(data.recent)
        ? data.recent.filter((r: RecentRepo) => r && typeof r.path === 'string')
        : [],
    };
  } catch {
    return { lastRepo: null, recent: [] };
  }
}

/** Record `target` as last used and move it to the top of the recent list. */
export async function rememberRepo(target: string) {
  const state = await loadState();
  state.lastRepo = target;
  state.recent = [
    { path: target, usedAt: Date.now() },
    ...state.recent.filter((r) => r.path !== target),
  ].slice(0, MAX_RECENT);
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await fsp.rename(tmp, STATE_FILE); // atomic
}

/** Expand `~`, require an absolute path, and check it is inside a git work tree. */
export async function resolveRepo(input: string): Promise<RepoRef> {
  let p = String(input ?? '').trim();
  if (!p) throw new Error('Enter a folder path.');
  p = expandHome(p);
  if (!path.isAbsolute(p)) throw new Error('Use an absolute path (or one starting with ~/).');
  const target = path.resolve(p);
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw new Error(`Folder does not exist: ${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${target}`);
  let inside = '';
  try {
    inside = (await git(['rev-parse', '--is-inside-work-tree'], target)).trim();
  } catch {
    /* not a repo */
  }
  if (inside !== 'true') throw new Error(`Not a git work tree: ${target}`);
  const root = (await git(['rev-parse', '--show-toplevel'], target)).trim();
  const gitDir = (await git(['rev-parse', '--absolute-git-dir'], target)).trim();
  return { target, root, gitDir };
}

/** Branch name read straight from .git/HEAD (cheap; no git process per repo). */
function quickBranch(dir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 7);
  } catch {
    return null; // .git is a file (worktree/submodule) or unreadable
  }
}

export interface FoundRepo {
  path: string;
  name: string;
  branch: string | null;
}

/** Git repos under REPOS_ROOT, SCAN_DEPTH levels deep (not descending into repos). */
export async function scanRepos(root = REPOS_ROOT, depth = SCAN_DEPTH): Promise<FoundRepo[]> {
  const found: FoundRepo[] = [];
  async function walk(dir: string, level: number) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, '.git'))) {
        found.push({ path: full, name: path.relative(root, full), branch: quickBranch(full) });
      } else if (level < depth) {
        await walk(full, level + 1);
      }
    }
  }
  await walk(root, 1);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
