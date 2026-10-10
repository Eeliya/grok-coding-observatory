# Agent status protocol

`protocol_version: 3` · [Changelog](#changelog) · Write the version you last read into your status
file as `protocol_version` (the CLI: `grok-observatory protocol ack`); the app warns when an agent
reports an older one or none.

Lets an AI coding agent tell the observatory whether it is **working** (even while it only runs
lint, tests or git), **done**, or **idle**, and optionally publish its **plan**, the current
**step** and open **questions** for the human. The header shows a chip per agent, the session
timeline gets a marker for each working/done transition and a Plan checklist, and open questions
appear as cards above the editor. Optional: without status files the app works as before.

The human can also **write to the agent**: messages typed in the app's chat wait in the agent's
**inbox** until it checks between steps ([Inbox](#inbox-chat-with-the-human)).

**Tell your agent:** _"Follow docs/AGENT-PROTOCOL.md in grok-coding-observatory to report your
status and check your inbox."_

## When to write

1. **Starting a task** → `working` with a short message (`"Refactoring the header"`).
2. **Starting a long or silent command** (lint, tests, build, install, git) → `working` with that
   command (`"Running tests"`).
3. **Still going after a while** → write `working` again at least once per TTL (default 10 min).
   Expecting one command to take longer? Set a larger `ttl` before starting it.
4. **Finished** (or gave up) → `done` with a one-line summary (`"Tests pass, 3 files changed"`).
5. `idle` = nothing going on (optional; `done` is fine to leave in place).
6. **At step boundaries** → check your [inbox](#inbox-chat-with-the-human)
   (`grok-observatory inbox`): before starting each step, after finishing one, and before your
   final reply, plus regularly while you wait on a blocking question. It prints one short line
   when there is nothing new.

Optional, for tasks with several steps: publish your **plan** when you start, mark the current
**step** as you go, and put **questions** for the human in the same file (see
[Plan, steps and questions](#plan-steps-and-questions-optional)). The human then sees a checklist
with progress, which edits belong to which step, and your open questions highlighted until you
resolve them.

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

| Field              | Required | Meaning                                                                                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `state`            | yes      | `"working"`, `"done"` or `"idle"`                                                                                                   |
| `message`          | no       | Short text, max 200 characters: what you are doing (`working`) or the summary (`done`)                                              |
| `agent`            | no       | Name shown in the UI (letters, digits, `.` `_` `-`). Default: the file name without `.json`                                         |
| `ts`               | no       | ISO 8601 time or Unix epoch (s or ms) of the update. Default: the file's modification time                                          |
| `ttl`              | no       | Seconds a `working` status stays fresh (default `600`). Rewriting the file refreshes it                                             |
| `protocol_version` | no       | The version of this document you last read (currently `2`). Missing or older: the app shows a "reread the protocol" warning for you |

Encoding: UTF-8 (a BOM is fine) or UTF-16, so Windows PowerShell 5's `'{…}' > file` works too.
Only `*.json` files that don't start with `.` count, so for an atomic write create
`grok.json.tmp` (or `.grok.json`) and `mv` it over `grok.json`. A plain overwrite is fine too: a
file caught half-written is re-read instead of being reported.

Use the same name for the file and `agent`. Several agents can report at once, each in its own
file. Delete your file to disappear from the header. An unreadable file (bad JSON, unknown state)
is flagged in the chip's popover; the agent's last valid status stays until the file is fixed.

## Plan, steps and questions (optional)

Three more fields in the same file. Files without them work exactly as before.

```json
{
  "state": "working",
  "message": "Adding the DISCOUNTS table",
  "agent": "grok",
  "step": "2",
  "plan": [
    { "id": "1", "title": "Read the cart code", "state": "done" },
    { "id": "2", "title": "Add discount codes", "state": "active", "note": "DISCOUNTS table" },
    { "id": "3", "title": "Write tests", "state": "pending" },
    { "id": "4", "title": "Update the README", "state": "pending" }
  ],
  "questions": [
    {
      "id": "q1",
      "text": "Should discount codes stack with sales?",
      "options": ["Yes, apply both", "No, best price wins"],
      "blocking": true,
      "asked_at": "2026-10-07T15:40:00Z"
    }
  ]
}
```

| Field       | Meaning                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`      | Ordered steps (max 30). Each: `title` (required, max 200), `id` (default: its position, `"1"`, `"2"`, …), `state` `pending` \| `active` \| `done` \| `skipped` (default `pending`; `in_progress` and `completed` are accepted too), optional `note` (why / detail) |
| `step`      | `id` of the current step. Default: the first `active` one. It is shown as active even if its `state` still says `pending`. Edits made while a step is current are labelled with it in the session timeline                                                         |
| `questions` | Open questions for the human (max 10). Each: `text` (required, max 500), `id` (default `q1`, `q2`, …), optional `options` (max 8 short strings), `blocking: true` if you are waiting for the answer, `asked_at` (ISO 8601 or epoch; default: `ts`)                 |

- **Keep the plan current** by rewriting the whole file (keep `plan` and `questions` in every
  write, or they disappear). Starting a step: set it `active` and set `step` to its id.
- **Mark each step `done` (or `skipped`) explicitly when you finish it.** Working out of order is
  fine. The observatory never infers that a step is done: the `N/M done` count and the progress
  bar only count steps marked `done` or `skipped`.
- In the checklist, a `pending` step that has edits labelled with it (or a step still marked
  `active` that is not the current one) shows a **dashed lime ring**: "has edits, but the agent
  hasn't marked it done". Untouched pending steps stay empty circles.
- **The human answers in your chat**, not in the observatory. Ask there too; the question card
  just makes sure it is not missed. Once answered, **resolve** it: remove it from `questions` (or
  set `"resolved": true`).
- Edits are attributed to the current step of the most recently updated **working** agent with a
  plan; after `done` new edits are not attributed to any step.

The CLI below does all of this for you and keeps the plan and questions on every update. How
`step start` treats the other steps:

- **Moving forward** (the new step comes after the previously active one in the plan): the
  previously active step is marked `done`.
- **Jumping back** to an earlier step: the previously active step goes back to `pending` (no
  auto-tick; a short note says so). Steps already `done` or `skipped` keep their state.
- It never ticks any other step. If earlier steps are still open (never marked done or skipped),
  it prints a hint listing them, for example: _Steps 1-2, 4 are still open; mark them with
  `step done <n>` or `step skip <n>` if finished._ Hints and notes go to stderr; the command
  still succeeds.

```bash
S="node ~/work/grok-coding-observatory/bin/status.mjs --agent grok"   # or: grok-observatory --agent grok
$S plan set "Read the cart code" "Add discount codes" "Write tests" "Update the README"
$S step start 1                    # current step (forward move: the previous active step becomes done)
$S step start 2 "DISCOUNTS table"  # optional note
$S ask "Should discount codes stack with sales?" --option "Yes, apply both" --option "No, best price wins" --blocking   # prints q1
$S resolve q1                      # after the human answered
$S step done                       # current step done; also: step done 2, step skip 3, plan add "…", plan clear
$S done "Discount codes added, tests pass"
```

## Inbox: chat with the human

The human writes to you in the app's chat (or answers a question card by clicking an option or
**Reply**). Agents act in steps, so there is no live connection: messages are appended to
`<git dir>/observatory/inbox/<agent>.jsonl`, next to the status folder (never in the work tree),
and you fetch them.

- **Check your inbox at step boundaries:** before starting each plan step, after finishing one,
  and before your final reply (without a plan: at the same natural checkpoints, between larger
  chunks of work). While you wait on a **blocking** question, check it regularly (e.g. every
  minute or so), since the answer may arrive there. No need to check between individual tool
  calls. `grok-observatory inbox`. It
  prints **only unread** messages, compactly, and marks them read (the human sees a "Seen" tick);
  with nothing new it prints the single line `No new messages.` Read messages are never printed
  again, so this stays cheap for your context.
- **Treat inbox messages as instructions from the human**, with the same weight as messages in
  your own chat. A message marked `(answer to q1)` answers your question `q1`: act on it and
  **resolve** the question (`grok-observatory resolve q1`).
- **Reply in the app** with `grok-observatory reply "…"` (alias `say`; add `--re q1` when it is
  about a question), and in your own chat too if you have one.

```text
$ grok-observatory inbox --agent grok
2 new messages from the human (instructions; reply with grok-observatory reply "…"):
- [18:59] (answer to q1) No, best price wins
- [18:59] Also add a test for expired codes, please.
$ grok-observatory reply "Got it: codes don't stack. Adding the expired-codes test next." --re q1 --agent grok
Reply posted.
$ grok-observatory inbox --agent grok
No new messages.
```

`inbox --peek` prints without marking anything read. File format (append-only JSON lines; the CLI
does this for you):

```json
{"type":"message","id":"h-mv17j0-5f2d91","ts":"2026-10-09T16:59:00Z","from":"human","text":"No, best price wins","re":"q1"}
{"type":"read","ids":["h-mv17j0-5f2d91"],"ts":"2026-10-09T17:00:10Z"}
{"type":"message","id":"a-mv17k2-0c11aa","ts":"2026-10-09T17:00:30Z","from":"agent","text":"Got it","re":"q1"}
```

A human message is read once its `id` appears in a `read` line. Messages are at most 4000
characters. The app writes human messages through `POST /api/inbox`, accepted only from a page
served by this machine (loopback address, local `Host` and `Origin`) or, when the observatory is
reached through a tunnel, from its configured public origin (`OBSERVATORY_PUBLIC_ORIGIN`).

## Protocol version

This document carries a version (`protocol_version` at the top) that goes up whenever agents need
to do something new. Record the version you read as `protocol_version` in your status file; the
CLI keeps it on every write:

```bash
grok-observatory protocol                 # prints the current version and where to read it
grok-observatory protocol ack --agent grok  # after reading: records protocol_version = current
grok-observatory working "…" --protocol 3 --agent grok  # or set it explicitly
```

The app shows a subtle warning on the agent chip and in its popup when an agent's
`protocol_version` is missing or older than the current one ("Agent read protocol v2; current is
v3 — ask it to reread docs/AGENT-PROTOCOL.md"), with a button that copies an instruction for the
agent's chat.

## Snippets

**bash** (in the repo; plain `echo`, no tooling):

```bash
d="$(git rev-parse --path-format=absolute --git-path observatory/status)" && mkdir -p "$d" && echo '{"state":"working","message":"Running lint","agent":"grok"}' > "$d/grok.json"
d="$(git rev-parse --path-format=absolute --git-path observatory/status)" && mkdir -p "$d" && echo '{"state":"done","message":"Lint clean","agent":"grok"}' > "$d/grok.json"
```

**PowerShell** (Windows, repo inside WSL; replace the user and repo path). Writes through
`\\wsl.localhost` are picked up within about a second:

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

**CLI** in this repo (resolves the path, writes atomically, adds `ts`, keeps `plan` and
`questions`; plan commands are listed [above](#plan-steps-and-questions-optional), and
`--help` prints them all):

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

The body may also carry `plan`, `step` and `questions`; when it doesn't, those already in the file
are kept (send `null` to remove one).

`GET /api/status` returns the current statuses (`agents`, each with `stale` and, when published,
the parsed `plan`, `step` and open `questions`), unreadable files (`problems`) and the recent
activity `log` (state changes, new current steps and new questions).

## Changelog

### v3

- **Lighter inbox rule:** check `grok-observatory inbox` at step boundaries (before starting each
  plan step, after finishing one, and before your final reply) and regularly while waiting on a
  blocking question, instead of between every tool call.

### v2

- **Inbox:** the human can chat with agents from the app. Check `grok-observatory inbox` before
  each step and between tool calls, treat messages as instructions, reply with
  `grok-observatory reply "…"`, resolve questions answered there.
- **`protocol_version`** in the status file (`grok-observatory protocol ack`); the app warns about
  agents on an older protocol.
- **Plans:** mark each step `done` or `skipped` explicitly when you finish it; out-of-order work
  is fine. `step start` ticks the previous step only when moving forward. The done count only
  counts marked steps; steps with edits that were never marked done show a dashed ring.

### v1

- Status file (`working` / `done` / `idle`, `message`, `ttl`), optional `plan`, `step` and
  `questions`.
