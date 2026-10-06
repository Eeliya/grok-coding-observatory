// The npx launcher (bin/observatory.mjs) with the package installed under node_modules, where Node
// itself refuses to strip types: it must still start the server on the current directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-npx-'));
let proc: ChildProcess | undefined;

after(() => {
  proc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('npx launcher serves the current directory from under node_modules', async () => {
  const pkgDir = path.join(tmp, 'node_modules', 'grok-coding-observatory');
  for (const entry of ['package.json', 'bin', 'src', 'public']) {
    fs.cpSync(path.join(ROOT, entry), path.join(pkgDir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkgDir, 'node_modules'), 'junction');

  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');

  // A clean env without the type-stripping flags `npm test` adds via NODE_OPTIONS.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '0',
    OBSERVATORY_CONFIG_DIR: path.join(tmp, 'config'),
  };
  delete env.NODE_OPTIONS;
  delete env.TARGET_DIR;
  proc = spawn(process.execPath, [path.join(pkgDir, 'bin', 'observatory.mjs')], { cwd: repo, env });
  const base = await new Promise<string>((resolve, reject) => {
    let out = '';
    const onData = (d: Buffer) => {
      out += d;
      const m = out.match(/Open (http:\/\/\S+)/);
      if (m) resolve(m[1].replace('localhost', '127.0.0.1'));
    };
    proc!.stdout!.on('data', onData);
    proc!.stderr!.on('data', onData);
    proc!.on('exit', (code) => reject(new Error(`launcher exited ${code}:\n${out}`)));
  });
  const info = (await (await fetch(`${base}/api/files`)).json()) as {
    root: string;
    files: { path: string }[];
  };
  assert.equal(fs.realpathSync(info.root), fs.realpathSync(repo));
  assert.deepEqual(
    info.files.map((f) => f.path),
    ['a.txt'],
  );
  const page = await fetch(base);
  assert.equal(page.status, 200);
});
