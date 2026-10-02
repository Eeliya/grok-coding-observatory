// Launcher for `npm start` / `npm test`: runs Node with the flags this Node version needs to load
// the TypeScript sources directly. Plain CommonJS with no modern syntax, so an old Node prints a
// clear message instead of a syntax error.
//
// - Node 22.6–22.17 / 23.0–23.5 can strip types only behind --experimental-strip-types; it goes in
//   NODE_OPTIONS so child processes (the tests spawn the server) inherit it.
// - .env is loaded with --env-file only when it exists (--env-file-if-exists needs 22.9).
'use strict';
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var signals = require('os').constants.signals;

var v = process.versions.node.split('.').map(Number);
function atLeast(major, minor) {
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

if (!atLeast(22, 6)) {
  console.error(
    'grok-coding-observatory needs Node.js 22.6 or newer (it runs TypeScript directly).\n' +
      'You have ' +
      process.version +
      '. Install a newer Node (e.g. `nvm install 22` — see .nvmrc) and try again.',
  );
  process.exit(1);
}

var env = Object.assign({}, process.env);
var stripsByDefault = atLeast(23, 6) || (v[0] === 22 && v[1] >= 18);
if (!stripsByDefault) {
  env.NODE_OPTIONS = [
    env.NODE_OPTIONS,
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
  ]
    .filter(Boolean)
    .join(' ');
}

var args = process.argv.slice(2);
var envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) args.unshift('--env-file=' + envFile);

var child = spawn(process.execPath, args, { stdio: 'inherit', env: env });
// Ctrl+C reaches the child directly (same process group); pass on a plain `kill` too.
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(function (sig) {
  process.on(sig, function () {
    child.kill(sig);
  });
});
child.on('exit', function (code, signal) {
  process.exit(signal ? 128 + (signals[signal] || 0) : code === null ? 1 : code);
});
