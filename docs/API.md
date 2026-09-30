# API reference

The server listens on `http://HOST:PORT` (default `127.0.0.1:4477`). All endpoints return JSON.
Paths are repo-relative with `/` separators; `..` and absolute paths are rejected (400).

## HTTP

| Method & path                                                           | Returns                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/files`                                                        | `{ target, root, head: { branch, sha, detached }, files: [{ path, status, category, editedAt?, hash }] }`                                                                                      |
| `GET /api/diff?path=<path>`                                             | `{ path, head, current, currentHash, binary }` – `HEAD` vs working copy                                                                                                                        |
| `GET /api/history`                                                      | `{ target, items }` – session timeline summaries (edits, HEAD markers and agent markers), oldest first                                                                                         |
| `GET /api/history/<id>`                                                 | One recorded edit: `{ path, status, before, after, hunks, hash, instant, ts }` (404 once expired)                                                                                              |
| `GET /api/commits?before=<sha>&limit=<n>`                               | `{ head, commits: [{ sha, short, parents, author, email, date, subject }], more }` – first-parent history of `HEAD`, newest first; `before` pages to older commits, `limit` ≤ 200 (default 50) |
| `GET /api/commit/<sha>`                                                 | Commit meta + `body`, `base` (first parent, `null` for a root commit), `files: [{ path, oldPath?, status, binary, plus, minus }]`, `truncated`                                                 |
| `GET /api/commit/<sha>/file?path=<path>`                                | One file of the commit as a playback event (`before`, `after`, `hunks`, `instant`)                                                                                                             |
| `GET /api/repos`                                                        | `{ current, scanRoot, recent, found }` for the picker                                                                                                                                          |
| `GET /api/status`                                                       | `{ dir, serverTime, agents: [{ agent, state, message, ts, ttl, stale }], problems: [{ file, error }], log }` – see [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md)                                      |
| `POST /api/status` `{"state": "working", "message"?, "agent"?, "ttl"?}` | Write that agent's status file (loopback clients only, else 403; JSON content type, else 415; invalid fields → 400)                                                                            |
| `POST /api/target` `{"path": "..."}`                                    | Switch the watched repo (JSON content type required, else 415; invalid path → 400 with a message)                                                                                              |

Shas must be 4–64 hex characters and resolve to a commit: otherwise 400 (format) or 404 (unknown
or not a commit). Merge commits are diffed against their first parent, root commits against the
empty tree.

## WebSocket `/ws`

Messages are JSON objects with a `type`:

| `type`    | When / payload                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `hello`   | On connect: `{ target, root, head }`                                                                                 |
| `files`   | Changed-files list updated: `{ files }`                                                                              |
| `history` | On connect: `{ items }` (same as `GET /api/history`)                                                                 |
| `change`  | A file edit: `{ id, ts, path, status, binary, before, after, hunks, hash, instant }`                                 |
| `status`  | On connect and whenever a status file changes: same payload as `GET /api/status`                                     |
| `marker`  | An agent changed state: `{ marker: { type: "marker", reason: "agent", id, ts, agent, state, message } }`             |
| `reset`   | `reason: "branch" \| "head"` (with a timeline `marker`) or `"repo"` (repo switched): `{ target, root, head, files }` |

`hunks` are `{ line, removed: string[], added: string[] }`, top to bottom, where `line` refers to
the buffer after the previous hunks were applied.
