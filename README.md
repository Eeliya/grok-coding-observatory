# grok-coding-observatory

A tiny local web app for **passively watching an AI coding assistant change code, like a video**.

The assistant edits files in a target project (for example `/home/eeliya/work/website-photo-motion`).
The observatory watches that project and replays every edit in the browser with Monaco: it jumps
to the changed hunk, highlights and deletes the removed lines, then types the new code
character by character.

## Features

- **Live replay** – every file save becomes a queued playback event; rapid successive changes are
  queued in order (nothing is dropped). Each event is diffed against the previous known content of
  the file (last snapshot, or `HEAD` the first time the file is touched).
- **Changed-files sidebar** – files that differ from git `HEAD`, grouped into **Changed**
  (modified / staged / deleted / renamed tracked files) and **Untracked** (new, not ignored;
  collapsed by default, state remembered). Git-ignored files are never shown. Files edited live
  get a blue ● marker (with a left accent bar for the first minute), and edited untracked files
  stay visible even when the Untracked group is collapsed. Updated live.
- **Diff vs HEAD** – click a file to open a side-by-side Monaco diff against `HEAD`. Live playback
  pauses (events keep queuing); press **Back to live** or `Esc` to resume.
- **Branch awareness** – the header shows the watched project's branch and short `HEAD` sha
  (or `detached · <sha>`). A checkout, commit, reset or any other `HEAD` move is treated as a
  reset: baselines and the file list are rebuilt from the new `HEAD` and nothing is replayed as
  typing (queued playback is dropped). Detected by a cheap 2 s poll plus a check before every
  replayed change; file events are held while git holds `index.lock`/`HEAD.lock`.
- **Big changes play instantly** – lock/generated files (`package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `composer.lock`, `*.min.js`, `*.map`, …) and any single change larger than
  80 changed lines or 4000 changed characters are shown at once: final content, scrolled to the
  first change, briefly highlighted, with a "shown instantly" note. When playback falls behind it
  fast-forwards: 4× faster from 3 queued events, instant from 8. All thresholds live in
  `public/playback-policy.js`.
- **Speed control** – Slow / Normal / Fast (default) / Turbo / Instant, remembered in
  `localStorage`.
- Syntax highlighting chosen by file extension, dark theme, minimal UI.
- Ignores `node_modules`, `.git`, `dist` and anything git-ignored.

## Requirements

- Node.js **22.18+** (runs TypeScript natively via type stripping; no build step)
- `git` on `PATH`; the target directory must be inside a git repository
- Internet access in the browser (Monaco is loaded from the jsDelivr CDN)

## Setup

```bash
cd /home/eeliya/work/grok-coding-observatory
npm install
```

## Usage

```bash
npm start -- /home/eeliya/work/website-photo-motion
```

Then open the printed URL, by default <http://localhost:4477>. From WSL this also works in the
Windows browser thanks to WSL localhost forwarding.

Alternatively configure it via environment variables (copy `.env.sample` to `.env`):

| Variable     | Default     | Description                                  |
| ------------ | ----------- | -------------------------------------------- |
| `TARGET_DIR` | –           | Project to watch (CLI argument wins)         |
| `PORT`       | `4477`      | HTTP / WebSocket port                        |
| `HOST`       | `127.0.0.1` | Interface to bind (`0.0.0.0` for LAN access) |

Leave the tab open while the assistant works; edits play back automatically.

## How it works

- `src/server.ts` – Node HTTP server + `ws` WebSocket + `chokidar` watcher, run directly by Node
  (no compile step). On each change it reads the file, diffs it line by line (`src/hunks.ts`, using
  `diff`) against the last snapshot and broadcasts `{ type: "change", path, before, after, hunks }`.
  Changes are debounced per file (60 ms) and processed through one serial queue, so each event
  starts exactly where the previous one ended. `git status --porcelain` drives the sidebar.
- `public/` – a single static page (vanilla JS modules, Monaco from CDN) that queues events and
  animates them. `public/replay.js` holds the pure edit operations; the same code is exercised by
  the tests, and after each event the buffer is forced to match the file exactly.

HTTP endpoints: `GET /api/files` (changed files), `GET /api/diff?path=<repo-relative path>`
(HEAD vs working copy), WebSocket at `/ws`.

## Development

```bash
npm run check         # typecheck + prettier check + tests
npm test              # unit (randomised replay) + end-to-end (temp git repo, real server)
npm run typecheck     # tsc --noEmit
npm run format        # prettier --write .
```

Running it detached from a one-off WSL command (e.g. from Windows):

```bash
wsl -d Ubuntu -- bash -lc "cd ~/work/grok-coding-observatory && setsid nohup npm start -- ~/work/website-photo-motion > /tmp/observatory.log 2>&1 < /dev/null &"
```
