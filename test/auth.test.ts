// Token login for remote access (src/auth.ts): login page, ?token= exchange, cookie and bearer
// auth, the WebSocket handshake, and chat posts from a configured public origin (tunnel).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Auth, authConfigFromEnv, loginPage, parseOrigins } from '../src/auth.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.ts');
const TOKEN = 'test-token-0123456789abcdef';
const PUBLIC = 'https://agents.example.com';
let tmp: string;
let repo: string;
let proc: ChildProcess | undefined;
let base: string;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function request(
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: pathname,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
const cookieOf = (r: Res) => String(r.headers['set-cookie']?.[0] ?? '').split(';')[0];

function wsOpen(headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-auth-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const tokenFile = path.join(tmp, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  proc = spawn(process.execPath, [SERVER, repo], {
    env: {
      ...process.env,
      PORT: '0',
      OBSERVATORY_CONFIG_DIR: path.join(tmp, 'config'),
      TARGET_DIR: '',
      OBSERVATORY_TOKEN: '',
      OBSERVATORY_TOKEN_FILE: tokenFile,
      OBSERVATORY_PUBLIC_ORIGIN: PUBLIC,
    },
  });
  base = await new Promise<string>((resolve, reject) => {
    let out = '';
    proc!.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/Open (http:\/\/\S+)/);
      if (m) resolve(m[1].replace('localhost', '127.0.0.1'));
    });
    proc!.stderr!.on('data', (d) => process.stderr.write(d));
    proc!.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc!.once('exit', r));
    proc.kill();
    await exited;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('config: token from env or file, minimum length, public origins', () => {
  assert.equal(authConfigFromEnv({}).token, null);
  assert.equal(
    authConfigFromEnv({ OBSERVATORY_TOKEN: ' abcdefghijklmnop ' }).token,
    'abcdefghijklmnop',
  );
  assert.throws(() => authConfigFromEnv({ OBSERVATORY_TOKEN: 'short' }), /at least 16/);
  assert.deepEqual(parseOrigins('https://a.example.com/, http://b.example.com:8080'), [
    'https://a.example.com',
    'http://b.example.com:8080',
  ]);
  assert.throws(() => parseOrigins('ftp://x'), /http\(s\)/);
  assert.throws(() => parseOrigins('nope'), /not a URL/);
  const off = new Auth({ token: null, publicOrigins: [] });
  assert.equal(off.enabled, false);
  assert.equal(off.checkToken('anything'), false, 'no token configured never matches');
  assert.match(loginPage({ next: '//evil.example' }), /name="next" value="\/"/);
});

test('without the token: login page for pages, 401 for the API, no WebSocket', async () => {
  const page = await request('/');
  assert.equal(page.status, 401);
  assert.match(page.body, /Enter the access token/);
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.doesNotMatch(page.body, new RegExp(TOKEN));
  const asset = await request('/app.js');
  assert.equal(asset.status, 401);
  assert.doesNotMatch(asset.body, /WebSocket/, 'app code is not served');
  const api = await request('/api/files');
  assert.equal(api.status, 401);
  assert.deepEqual(JSON.parse(api.body), { error: 'login required (token)' });
  const inbox = await request('/api/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'grok', text: 'hi' }),
  });
  assert.equal(inbox.status, 401);
  assert.equal(await wsOpen({}), 401);
  const wrong = await request('/?token=wrong-token-0123456789');
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /not valid/);
  assert.equal(
    (await request('/api/files', { headers: { cookie: 'observatory_session=x' } })).status,
    401,
  );
});

test('?token= sets an HttpOnly cookie and redirects without the token', async () => {
  const r = await request(`/?token=${TOKEN}&x=1`, { headers: { host: 'agents.example.com' } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/?x=1');
  const set = String(r.headers['set-cookie']?.[0]);
  assert.match(set, /^observatory_session=/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Secure/, 'Secure on a public host');
  assert.doesNotMatch(set, new RegExp(TOKEN), 'the cookie is derived, not the token itself');
  const cookie = cookieOf(r);
  const page = await request('/', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<div id="stage"|id="chat"/);
  assert.equal((await request('/api/files', { headers: { cookie } })).status, 200);
  assert.equal(await wsOpen({ cookie }), 'open');
  // Local http keeps working in every browser (no Secure on a local http host).
  const local = await request(`/?token=${TOKEN}`);
  assert.doesNotMatch(String(local.headers['set-cookie']?.[0]), /Secure/);
});

test('login form and bearer token', async () => {
  const bad = await request('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=nope&next=%2F',
  });
  assert.equal(bad.status, 401);
  const ok = await request('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: `token=${TOKEN}&next=%2Fapi%2Ffiles`,
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/api/files');
  assert.equal((await request('/api/files', { headers: { cookie: cookieOf(ok) } })).status, 200);
  const offsite = await request('/__login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://evil.example',
    },
    body: `token=${TOKEN}&next=%2F`,
  });
  assert.equal(offsite.status, 403, 'login CSRF refused');
  const evilNext = await request('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${TOKEN}&next=%2F%2Fevil.example`,
  });
  assert.equal(evilNext.headers.location, '/', 'no open redirect');
  const bearer = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await request('/api/status', { headers: bearer })).status, 200);
  assert.equal(await wsOpen(bearer), 'open');
});

test('chat posts through a tunnel: the configured public origin only', async () => {
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const body = JSON.stringify({ agent: 'tunnel-test', text: 'TEST message, ignore' });
  const post = (headers: Record<string, string>) =>
    request('/api/inbox', { method: 'POST', headers: { ...auth, ...headers }, body });
  const ok = await post({ host: 'agents.example.com', origin: PUBLIC });
  assert.equal(ok.status, 200, ok.body);
  const file = path.join(repo, '.git', 'observatory', 'inbox', 'tunnel-test.jsonl');
  assert.match(fs.readFileSync(file, 'utf8'), /TEST message, ignore/);
  assert.equal(
    (await post({ host: 'agents.example.com', origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await post({ host: 'agents.example.com' })).status, 403, 'Origin required there');
  assert.equal(
    (await post({ host: 'other.example.com', origin: 'https://other.example.com' })).status,
    403,
  );
  assert.equal(
    (await post({ host: 'agents.example.com', origin: 'http://agents.example.com' })).status,
    403,
  );
  assert.equal((await post({ origin: base })).status, 200, 'local pages still work');
  // WebSockets: same-page origins only.
  const bearer = { authorization: `Bearer ${TOKEN}` };
  assert.equal(await wsOpen({ ...bearer, origin: PUBLIC }), 'open');
  assert.equal(await wsOpen({ ...bearer, origin: 'https://evil.example' }), 401);
});
