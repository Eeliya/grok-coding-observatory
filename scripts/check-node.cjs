// Runs before `npm start` on any Node version (plain CommonJS, no modern syntax), so an
// old Node prints a clear message instead of failing to load the TypeScript server.
var parts = process.versions.node.split('.').map(Number);
var ok = parts[0] > 22 || (parts[0] === 22 && parts[1] >= 18);
if (!ok) {
  console.error(
    'grok-coding-observatory needs Node.js 22.18 or newer (it runs TypeScript directly).\n' +
      'You have ' +
      process.version +
      '. Install a newer Node (e.g. `nvm install 22` — see .nvmrc) and try again.',
  );
  process.exit(1);
}
