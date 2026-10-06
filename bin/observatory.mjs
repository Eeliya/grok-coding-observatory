#!/usr/bin/env node
// `npx github:Eeliya/grok-coding-observatory [path]`: starts the observatory on the given repo
// (default: the current directory) and prints the URL. Runs the TypeScript sources directly, with no
// build step. Node refuses to strip types from files under node_modules (where npx installs this
// package), so ts-hook.mjs strips them with amaro, the same stripper Node uses internally.
// Only node: builtins are imported statically so an old Node gets the version message below.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const USAGE = `Usage: npx github:Eeliya/grok-coding-observatory [path/to/repo]

Watches the git repo at the given path (default: the current folder) and serves the observatory
on http://localhost:4477. Environment: PORT, HOST, REPOS_ROOT, ... (see the README).`;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6) || typeof nodeModule.register !== 'function') {
  console.error(
    `grok-coding-observatory needs Node.js 22.6 or newer (it runs TypeScript directly).\n` +
      `You have ${process.version}. Install a newer Node from https://nodejs.org and try again.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes('-v') || args.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}
const unknown = args.find((a) => a.startsWith('-'));
if (unknown) {
  console.error(`grok-coding-observatory: unknown option ${unknown}\n\n${USAGE}`);
  process.exit(2);
}

// Path argument wins, then TARGET_DIR, then the current folder if it is inside a git work tree
// (otherwise the server falls back to the last repo or the picker in the browser).
let target = args[0] ? path.resolve(args[0]) : undefined;
if (!target && !process.env.TARGET_DIR) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    target = process.cwd();
  } catch {
    console.log(`${process.cwd()} is not inside a git repo — pick a repo in the browser.`);
  }
}

nodeModule.register('./ts-hook.mjs', import.meta.url, {
  data: { root: pathToFileURL(path.join(ROOT, 'src') + path.sep).href },
});
const server = path.join(ROOT, 'src', 'server.ts');
process.argv = [process.argv[0], server, ...(target ? [target] : [])];
await import(pathToFileURL(server).href);
