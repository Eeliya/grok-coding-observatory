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
  pauses (events keep queuing); press **● Live** or `Esc` to resume.
- **Session timeline** – a strip along the bottom lists every edit seen this session, in order,
  with file name, time and `+added −removed` lines (queued edits are dashed, the playing one is
  underlined). Commits / `HEAD` moves (`● <sha>`) and branch switches (`⎇ <branch>`) add a marker
  instead of wiping it; switching repos clears it. Click an edit to replay exactly that change
  (its before → after) in the editor; **● Live** returns to live playback. The history is kept on
  the server (in memory, last 500 edits / ~50 MB of content), so a page refresh doesn't lose it.
- **Pause and step** – **❚❚** pauses live playback: new edits queue up (header shows
  “Paused · N waiting”) and the timeline marks them pending. **‹ / ›** step through the timeline
  one edit at a time; while paused in live mode, **›** plays exactly the next queued edit.
- **What changed since I last looked** – the browser remembers, per repo (`localStorage` key
  `observatory.seen:<repo path>`), the content hash of each changed file you have seen. A file
  counts as seen when its playback finished or you opened its diff. Files with unseen changes get
  an orange dot, and a bar at the top of the sidebar shows the count with **Mark all seen**. The
  diff view has a **since last look** toggle that diffs the file against the content you last saw
  (snapshots up to 200 KB are kept; the first visit to a repo takes the current state as seen).
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
npm start
```

Open <http://localhost:4477> (also works from the Windows browser via WSL localhost forwarding).

- **Pick the repo in the browser.** Click the repo name in the header (or “Choose repo…”) to open
  the picker: recent repos, git repos found under `~/work` (two levels deep), or type any absolute
  path (`~/…` works) and press Enter. Typing also filters the lists; Enter picks a single match.
  The switch is live: the old watcher stops, the new repo's branch, file list and playback reset.
- **Remembered.** The last used repo is watched again on the next `npm start`; recent repos are
  kept in `~/.config/grok-coding-observatory/state.json`.
- **Optional start path.** `npm start -- /path/to/project` watches that repo right away (and makes
  it the last used one). With no argument and nothing remembered, the picker opens by itself.

Optional environment variables (copy `.env.sample` to `.env`):

| Variable                 | Default                             | Description                                  |
| ------------------------ | ----------------------------------- | -------------------------------------------- |
| `TARGET_DIR`             | –                                   | Initial repo (CLI argument wins)             |
| `PORT`                   | `4477`                              | HTTP / WebSocket port                        |
| `HOST`                   | `127.0.0.1`                         | Interface to bind (`0.0.0.0` for LAN access) |
| `REPOS_ROOT`             | `~/work`                            | Folder scanned for repos in the picker       |
| `OBSERVATORY_CONFIG_DIR` | `~/.config/grok-coding-observatory` | Where recent / last-used repos are stored    |

Leave the tab open while the assistant works; edits play back automatically.

Keyboard shortcuts (ignored while typing in an input):

| Key     | Action                                                                        |
| ------- | ----------------------------------------------------------------------------- |
| `Space` | Pause / resume live playback                                                  |
| `←`/`→` | Previous / next edit in the timeline (`→` while paused plays the next queued) |
| `Esc`   | Close the picker → leave diff / timeline view back to live → resume if paused |

## How it works

- `src/server.ts` – Node HTTP server + `ws` WebSocket, run directly by Node (no compile step).
  Owns the current watch session and switches it live (`POST /api/target`); `src/repos.ts`
  validates paths, scans for repos and persists recent / last-used repos.
- `src/session.ts` – one watched work tree: `chokidar` watcher, snapshots and HEAD tracking. On each change it reads the file, diffs it line by line (`src/hunks.ts`, using
  `diff`) against the last snapshot and broadcasts `{ type: "change", path, before, after, hunks }`.
  Changes are debounced per file (60 ms) and processed through one serial queue, so each event
  starts exactly where the previous one ended. `git status --porcelain` drives the sidebar.
- `public/` – a single static page (vanilla JS modules, Monaco from CDN) that queues events and
  animates them. `public/replay.js` holds the pure edit operations; the same code is exercised by
  the tests, and after each event the buffer is forced to match the file exactly.

HTTP endpoints: `GET /api/files` (current repo, HEAD, changed files), `GET /api/diff?path=<repo-relative path>`
(HEAD vs working copy, plus `currentHash`), `GET /api/history` (session timeline summaries),
`GET /api/history/<id>` (one full recorded edit: before, after, hunks), `GET /api/repos` (recent + discovered repos), `POST /api/target`
(`{"path": "..."}`, JSON only) to switch repos, WebSocket at `/ws`.

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
