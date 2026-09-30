import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileP = promisify(execFile);
// Never take optional locks (e.g. `git status` refreshing the index), so the
// observatory can't interfere with the user's own git commands.
export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const MAX_BUFFER = 256 * 1024 * 1024;

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env: GIT_ENV, maxBuffer: MAX_BUFFER });
  return stdout;
}

export async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: GIT_ENV,
    maxBuffer: MAX_BUFFER,
    encoding: 'buffer',
  });
  return stdout;
}
