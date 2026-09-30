# Agent status protocol

Lets an AI coding agent tell the observatory whether it is **working** (even while it only runs
lint, tests or git), **done**, or **idle**. The header shows a chip per agent and the session
timeline gets a marker for each working/done transition. Optional: without status files the app
works as before.

**Tell your agent:** _"Follow docs/AGENT-PROTOCOL.md in grok-coding-observatory to report your
status."_

## When to write

1. **Starting a task** → `working` with a short message (`"Refactoring the header"`).
2. **Starting a long or silent command** (lint, tests, build, install, git) → `working` with that
   command (`"Running tests"`).
3. **Still going after a while** → write `working` again at least once per TTL (default 10 min).
   Expecting one command to take longer? Set a larger `ttl` before starting it.
4. **Finished** (or gave up) → `done` with a one-line summary (`"Tests pass, 3 files changed"`).
5. `idle` = nothing going on (optional; `done` is fine to leave in place).

A `working` status that is not refreshed within its TTL is shown as **possibly stalled · last seen
X ago**. `done` and `idle` never go stale.

## Where: one file per agent in the repo's git dir

```
<git dir>/observatory/status/<agent>.json
```

Get the folder with `git rev-parse --path-format=absolute --git-path observatory/status` (git ≥
2.31), run in the repo the observatory watches. Usually that is `<repo>/.git/observatory/status/`;
in a linked worktree it is `<main repo>/.git/worktrees/<name>/observatory/status/`. It is inside
the git dir, so it is never committed and never shows up as a change. The observatory creates the
folder when it starts watching; create it yourself (`mkdir -p`) if you write earlier. Changes are
picked up within about a second, no server connection needed.

## Schema

```json
{
  "state": "working",
  "message": "Running lint",
  "agent": "grok",
  "ts": "2026-09-30T13:40:00Z",
  "ttl": 600
}
```

| Field     | Required | Meaning                                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------------------- |
| `state`   | yes      | `"working"`, `"done"` or `"idle"`                                                           |
| `message` | no       | Short text, max 200 characters: what you are doing (`working`) or the summary (`done`)      |
| `agent`   | no       | Name shown in the UI (letters, digits, `.` `_` `-`). Default: the file name without `.json` |
| `ts`      | no       | ISO 8601 time or Unix epoch (s or ms) of the update. Default: the file's modification time  |
| `ttl`     | no       | Seconds a `working` status stays fresh (default `600`). Rewriting the file refreshes it     |

Use the same name for the file and `agent`. Several agents can report at once, each in its own
file. Delete your file to disappear from the header. An unreadable file (bad JSON, unknown state)
is flagged in the chip's popover; the agent's last valid status stays until the file is fixed.

## Snippets

**bash** (in the repo; plain `echo`, no tooling):

```bash
d="$(git rev-parse --path-format=absolute --git-path observatory/status)" && mkdir -p "$d" && echo '{"state":"working","message":"Running lint","agent":"grok"}' > "$d/grok.json"
d="$(git rev-parse --path-format=absolute --git-path observatory/status)" && mkdir -p "$d" && echo '{"state":"done","message":"Lint clean","agent":"grok"}' > "$d/grok.json"
```

**PowerShell** (Windows, repo inside WSL; replace the user and repo path). Use
`[IO.File]::WriteAllText`: it writes UTF-8 without a BOM (a BOM is tolerated, but avoid it):

```powershell
$d = "\\wsl.localhost\Ubuntu\home\<user>\work\<repo>\.git\observatory\status"; New-Item -ItemType Directory -Force $d | Out-Null; [IO.File]::WriteAllText("$d\grok.json", '{"state":"working","message":"Running tests","agent":"grok"}')
[IO.File]::WriteAllText("$d\grok.json", '{"state":"done","message":"Tests pass","agent":"grok"}')
```

**Node** (no dependencies):

```js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const dir = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-path', 'observatory/status'],
  { encoding: 'utf8' },
).trim();
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  `${dir}/grok.json`,
  JSON.stringify({
    state: 'working',
    message: 'Running tests',
    agent: 'grok',
    ts: new Date().toISOString(),
  }),
);
```

## Alternatives

**CLI** in this repo (resolves the path, writes atomically, adds `ts`):

```bash
node ~/work/grok-coding-observatory/bin/status.mjs working "Running lint" --agent grok [--ttl 1800] [--repo <path>]
node ~/work/grok-coding-observatory/bin/status.mjs done "Lint clean" --agent grok
# from Windows: wsl -d Ubuntu -- node /home/<user>/work/grok-coding-observatory/bin/status.mjs done "Lint clean" --agent grok --repo /home/<user>/work/<repo>
```

(`npm link` in this repo also installs it as `grok-observatory status working "…"`.)

**HTTP** (observatory must be running; localhost only; `Content-Type: application/json` required,
otherwise 415). Writes the status file of the repo currently shown:

```bash
curl -s -X POST http://127.0.0.1:4477/api/status -H 'Content-Type: application/json' -d '{"state":"working","message":"Running tests","agent":"grok","ttl":900}'
```

`GET /api/status` returns the current statuses (`agents`, each with `stale`), unreadable files
(`problems`) and the recent activity `log`.
