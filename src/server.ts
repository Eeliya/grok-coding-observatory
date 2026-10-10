// Grok Coding Observatory — watches a git project and streams file edits to the browser.
// The watched repo can be switched live from the UI (POST /api/target).
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Session, describeHead, safeRel, type ChangeEvent, type HeadInfo } from './session.ts';
import { commitDetail, commitFileEvent, listCommits, resolveCommit } from './commits.ts';
import {
  StatusWatcher,
  isLoopback,
  statusDir,
  writeStatus,
  type StatusLogEntry,
} from './status.ts';
import { InboxWatcher, appendMessage, inboxDir } from './inbox.ts';
import { PROTOCOL_INFO } from './protocol.ts';
import { Auth, LOGIN_PATH, authConfigFromEnv, loginPage } from './auth.ts';
import { REPOS_ROOT, loadState, rememberRepo, resolveRepo, scanRepos } from './repos.ts';

export type { ChangeEvent, ChangedFile, HeadInfo } from './session.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = process.env.PORT === undefined ? 4477 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 64 * 1024;

let auth: Auth;
try {
  auth = new Auth(authConfigFromEnv());
} catch (err) {
  console.error(`Cannot start: ${(err as Error).message}`);
  process.exit(1);
}
/** Session timeline caps (in memory; cleared when switching repos). */
const HISTORY_MAX_ITEMS = 500;
const HISTORY_MAX_BYTES = 50 * 1024 * 1024;

interface Marker {
  type: 'marker';
  id: number;
  ts: number;
  reason: 'branch' | 'head' | 'agent';
  head?: HeadInfo;
  /** For agent markers: who changed state, and to what. */
  agent?: string;
  state?: string;
  message?: string;
  /** Agent markers for a new current step or a new question (absent for state changes). */
  kind?: 'step' | 'question';
  ref?: string;
  blocking?: boolean;
}
type HistoryItem = ChangeEvent | Marker;
let history: HistoryItem[] = [];
let historyBytes = 0;

const itemBytes = (i: HistoryItem) =>
  i.type === 'change' ? (i.before.length + i.after.length) * 2 + 512 : 256;

function record(item: HistoryItem) {
  history.push(item);
  historyBytes += itemBytes(item);
  while (history.length > HISTORY_MAX_ITEMS || historyBytes > HISTORY_MAX_BYTES) {
    historyBytes -= itemBytes(history.shift()!);
  }
}

function clearHistory() {
  history = [];
  historyBytes = 0;
}

/** Compact timeline entry (full before/after is fetched on demand). */
function summarize(i: HistoryItem) {
  if (i.type === 'marker') return i;
  let plus = 0;
  let minus = 0;
  for (const h of i.hunks) {
    plus += h.added.length;
    minus += h.removed.length;
  }
  return {
    type: 'edit',
    id: i.id,
    ts: i.ts,
    path: i.path,
    status: i.status,
    instant: i.instant,
    plus,
    minus,
    ...(i.step ? { step: i.step } : {}),
  };
}

/** Messages from the active session: record edits, turn HEAD resets into timeline markers. */
function onSessionMessage(message: object) {
  let msg = message as { type: string; [k: string]: any };
  if (msg.type === 'change') {
    // Attribute the edit to the plan step that is current right now (if any agent has one).
    const step = statusWatcher?.currentStep();
    if (step) msg.step = step;
    record(msg as ChangeEvent);
  }
  if (msg.type === 'reset' && (msg.reason === 'branch' || msg.reason === 'head')) {
    const marker: Marker = {
      type: 'marker',
      id: ++eventId,
      ts: Date.now(),
      reason: msg.reason,
      head: msg.head,
    };
    record(marker);
    msg = { ...msg, marker };
  }
  broadcast(msg);
}

let session: Session | null = null;
let statusWatcher: StatusWatcher | null = null;
let inboxWatcher: InboxWatcher | null = null;

const emptyStatus = () => ({
  dir: null,
  serverTime: Date.now(),
  protocol: PROTOCOL_INFO,
  agents: [],
  problems: [],
  log: [],
});
const statusSnapshot = () => statusWatcher?.snapshot() ?? emptyStatus();
const inboxSnapshot = () => inboxWatcher?.snapshot() ?? { dir: null, threads: {} };

function onInboxChange(w: InboxWatcher) {
  if (w === inboxWatcher) broadcast({ type: 'inbox', ...w.snapshot() });
}

/** The chat inbox is optional too. */
async function startInboxWatcher(target: string): Promise<InboxWatcher | null> {
  try {
    const w = new InboxWatcher(await inboxDir(target), onInboxChange);
    await w.start();
    return w;
  } catch (err) {
    console.warn('Agent inbox disabled:', (err as Error).message);
    return null;
  }
}

/** Agent status files changed: timeline markers for state transitions, then tell clients. */
function onStatusChange(w: StatusWatcher, transitions: StatusLogEntry[]) {
  if (w !== statusWatcher) return;
  for (const t of transitions) {
    const marker: Marker = {
      type: 'marker',
      id: ++eventId,
      ts: Date.now(),
      reason: 'agent',
      agent: t.agent,
      state: t.state,
      message: t.message,
      ...(t.kind ? { kind: t.kind, ref: t.ref } : {}),
      ...(t.blocking ? { blocking: true } : {}),
    };
    record(marker);
    broadcast({ type: 'marker', marker });
  }
  broadcast({ type: 'status', ...w.snapshot() });
}

/** Status is optional: a failure here never blocks watching the repo. */
async function startStatusWatcher(target: string): Promise<StatusWatcher | null> {
  try {
    const w = new StatusWatcher(await statusDir(target), onStatusChange);
    await w.start();
    return w;
  } catch (err) {
    console.warn('Agent status disabled:', (err as Error).message);
    return null;
  }
}
let eventId = 0;
let switchQueue: Promise<unknown> = Promise.resolve();

/** Validate `input`, start watching it, then drop the old watcher and reset clients. */
function switchTo(input: string): Promise<Session> {
  const job = switchQueue.then(async () => {
    const ref = await resolveRepo(input);
    const next = new Session({ ...ref, emit: onSessionMessage, nextId: () => ++eventId });
    await next.start(); // if this throws, the current session keeps running
    const nextStatus = await startStatusWatcher(ref.target);
    const nextInbox = await startInboxWatcher(ref.target);
    const old = session;
    session = next;
    statusWatcher?.close();
    statusWatcher = nextStatus;
    inboxWatcher?.close();
    inboxWatcher = nextInbox;
    await old?.close();
    await rememberRepo(ref.target).catch((err) =>
      console.warn('Could not save recent repos:', (err as Error).message),
    );
    console.log(
      `Watching ${ref.target} · ${describeHead(next.head)} · ${next.files.length} changed file(s) vs HEAD`,
    );
    clearHistory();
    broadcast({ type: 'reset', reason: 'repo', ...next.info() });
    broadcast({ type: 'status', ...statusSnapshot() });
    broadcast({ type: 'inbox', ...inboxSnapshot() });
    return next;
  });
  switchQueue = job.catch(() => {});
  return job;
}

function currentInfo() {
  return session ? session.info() : { target: null, root: null, head: null, files: [] };
}

// ---------------------------------------------------------------- http + ws

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return data && typeof data === 'object' ? data : {};
}

/**
 * Writes that reach an agent (chat messages are instructions) must come from a page served by
 * this machine: loopback peer, a local Host header (no DNS rebinding) and, when the browser
 * sends one, a local Origin (no cross-site form posts). Through a tunnel, the configured public
 * origin (OBSERVATORY_PUBLIC_ORIGIN) counts as well, with a matching Host and Origin.
 */
function isLocalRequest(req: http.IncomingMessage) {
  return auth.isTrustedWrite(req, isLoopback(req.socket.remoteAddress));
}

function sendLogin(
  res: http.ServerResponse,
  status: number,
  opts: { error?: boolean; next?: string },
) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(loginPage(opts));
}

async function readForm(req: http.IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Token login (only when OBSERVATORY_TOKEN / OBSERVATORY_TOKEN_FILE is set). Returns true when
 * the request was answered here (login page, redirect, 401).
 */
async function authGate(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!auth.enabled) return false;
  if (url.pathname === LOGIN_PATH && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== String(req.headers.host ?? '').toLowerCase()) {
        res.writeHead(403).end('Cross-site login refused');
        return true;
      }
    }
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      res.writeHead(413).end('Too large');
      return true;
    }
    const next = form.get('next') ?? '/';
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    if (!auth.checkToken(form.get('token'))) {
      sendLogin(res, 401, { error: true, next: safeNext });
      return true;
    }
    res.writeHead(303, {
      location: safeNext,
      'set-cookie': auth.sessionCookie(req),
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }
  const given = url.searchParams.get('token');
  if (given !== null && req.method === 'GET') {
    url.searchParams.delete('token');
    const next = url.pathname + url.search;
    if (!auth.checkToken(given)) {
      sendLogin(res, 401, { error: true, next });
      return true;
    }
    res.writeHead(303, {
      location: next,
      'set-cookie': auth.sessionCookie(req),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end();
    return true;
  }
  if (auth.isAuthorized(req)) return false;
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'login required (token)' });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    sendLogin(res, 401, { next: url.pathname === LOGIN_PATH ? '/' : url.pathname + url.search });
  } else {
    res.writeHead(401).end('Login required');
  }
  return true;
}

async function listRepos() {
  const state = await loadState();
  return {
    current: session?.target ?? null,
    scanRoot: REPOS_ROOT,
    recent: state.recent.map((r) => ({
      path: r.path,
      name: path.basename(r.path),
      usedAt: r.usedAt,
      exists: fs.existsSync(r.path),
    })),
    found: await scanRepos(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (await authGate(req, res, url)) return;
    if (url.pathname === '/api/files') return sendJson(res, 200, currentInfo());
    if (url.pathname === '/api/history') {
      return sendJson(res, 200, { target: session?.target ?? null, items: history.map(summarize) });
    }
    const hist = url.pathname.match(/^\/api\/history\/(\d+)$/);
    if (hist) {
      const item = history.find((i) => i.id === Number(hist[1]));
      if (!item) return sendJson(res, 404, { error: 'not in history (expired or unknown id)' });
      return sendJson(res, 200, item);
    }
    if (url.pathname === '/api/commits') {
      const s = session;
      if (!s) return sendJson(res, 409, { error: 'no repo selected' });
      const before = url.searchParams.get('before');
      if (before !== null && !/^[0-9a-f]{4,64}$/i.test(before)) {
        return sendJson(res, 400, { error: 'invalid sha' });
      }
      const limit = Number(url.searchParams.get('limit') ?? 50);
      try {
        return sendJson(res, 200, {
          head: s.head,
          ...(await listCommits(s.root, { before, limit })),
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) return sendJson(res, 404, { error: 'unknown commit' });
        throw err;
      }
    }
    const commit = url.pathname.match(/^\/api\/commit\/([^/]+)(\/file)?$/);
    if (commit) {
      const s = session;
      if (!s) return sendJson(res, 409, { error: 'no repo selected' });
      if (!/^[0-9a-f]{4,64}$/i.test(commit[1])) return sendJson(res, 400, { error: 'invalid sha' });
      const full = await resolveCommit(s.root, commit[1]);
      if (!full) return sendJson(res, 404, { error: 'unknown commit' });
      const detail = await commitDetail(s.root, full);
      if (!commit[2]) return sendJson(res, 200, detail);
      const rel = safeRel(url.searchParams.get('path'));
      if (!rel) return sendJson(res, 400, { error: 'invalid path' });
      const ev = await commitFileEvent(s.root, detail, rel);
      if (!ev) return sendJson(res, 404, { error: 'file not changed in this commit' });
      return sendJson(res, 200, ev);
    }
    if (url.pathname === '/api/status') {
      if (req.method === 'GET') return sendJson(res, 200, statusSnapshot());
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' });
      if (!isLoopback(req.socket.remoteAddress)) {
        return sendJson(res, 403, { error: 'status updates are accepted from localhost only' });
      }
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Expected application/json' });
      }
      const w = statusWatcher;
      if (!w) return sendJson(res, 409, { error: 'no repo selected' });
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      try {
        const status = await writeStatus(w.dir, body);
        await w.rescan();
        return sendJson(res, 200, { ok: true, status });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/api/inbox') {
      if (req.method === 'GET') return sendJson(res, 200, inboxSnapshot());
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' });
      if (!isLocalRequest(req)) {
        return sendJson(res, 403, { error: 'chat messages are accepted from this machine only' });
      }
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Expected application/json' });
      }
      const w = inboxWatcher;
      if (!w) return sendJson(res, 409, { error: 'no repo selected' });
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      try {
        const message = await appendMessage(w.dir, body);
        await w.rescan();
        return sendJson(res, 200, { ok: true, message });
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        return sendJson(res, status, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/api/repos') return sendJson(res, 200, await listRepos());
    if (url.pathname === '/api/target') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      // JSON-only (forces a CORS preflight, so other sites can't switch the repo).
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Expected application/json' });
      }
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      try {
        const s = await switchTo(String(body.path ?? ''));
        return sendJson(res, 200, { ok: true, ...s.info() });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/api/diff') {
      const s = session;
      if (!s) return sendJson(res, 409, { error: 'no repo selected' });
      const rel = safeRel(url.searchParams.get('path'));
      if (!rel) return sendJson(res, 400, { error: 'invalid path' });
      const [head, current, currentHash] = await Promise.all([
        s.readHead(rel),
        s.readWorking(rel),
        s.fileHash(rel),
      ]);
      return sendJson(res, 200, {
        path: rel,
        currentHash,
        binary: head.binary || current.binary,
        head: head.text,
        current: current.text,
      });
    }
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const abs = path.resolve(PUBLIC_DIR, file);
    if (!abs.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') res.writeHead(404).end('Not found');
    else {
      console.error(err);
      res.writeHead(500).end('Internal error');
    }
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Same token as the page, and no cross-site pages reading the stream.
  verifyClient: ({ req }: { req: http.IncomingMessage }) =>
    auth.isAuthorized(req) && auth.isAllowedSocketOrigin(req),
});
function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}
wss.on('connection', (ws) => {
  const info = currentInfo();
  ws.send(JSON.stringify({ type: 'hello', target: info.target, root: info.root, head: info.head }));
  ws.send(JSON.stringify({ type: 'files', files: info.files }));
  ws.send(JSON.stringify({ type: 'history', items: history.map(summarize) }));
  ws.send(JSON.stringify({ type: 'status', ...statusSnapshot() }));
  ws.send(JSON.stringify({ type: 'inbox', ...inboxSnapshot() }));
});

// ---------------------------------------------------------------- startup

// Initial repo: CLI argument / TARGET_DIR, else the last used one, else the UI picker.
const cliTarget = process.argv[2] || process.env.TARGET_DIR;
const initial = cliTarget || (await loadState()).lastRepo;
if (initial) {
  try {
    await switchTo(initial);
  } catch (err) {
    console.error(`Cannot watch ${initial}: ${(err as Error).message}`);
    if (cliTarget) process.exit(1);
  }
}
if (!session) console.log('No repo selected yet — pick one in the browser.');

// Friendly message instead of a stack trace when the port is taken (e.g. a second copy).
wss.on('error', () => {}); // ws re-emits server errors; handled below
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} on ${HOST} is already in use — is the observatory already running?\n` +
        `Open http://localhost:${PORT}, stop the other process, or start on another port: PORT=4478 npm start`,
    );
  } else {
    console.error(`Cannot listen on ${HOST}:${PORT}: ${err.message}`);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const { port } = server.address() as AddressInfo;
  const shownHost = HOST === '0.0.0.0' || HOST === '127.0.0.1' ? 'localhost' : HOST;
  console.log(`Open http://${shownHost}:${port}`);
  if (auth.enabled) console.log('Token login is on (OBSERVATORY_TOKEN).');
  for (const origin of auth.publicOrigins) console.log(`Public origin: ${origin}`);
  if (auth.publicOrigins.length && !auth.enabled) {
    console.warn(
      'Warning: OBSERVATORY_PUBLIC_ORIGIN is set without OBSERVATORY_TOKEN; anyone who can reach ' +
        'that address can read your code unless something else (e.g. Cloudflare Access) protects it.',
    );
  }
});

function shutdown() {
  statusWatcher?.close();
  inboxWatcher?.close();
  void session?.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
