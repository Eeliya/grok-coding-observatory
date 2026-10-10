// Optional token login for remote access (e.g. through a Cloudflare Tunnel).
//
// When OBSERVATORY_TOKEN (or OBSERVATORY_TOKEN_FILE) is set, every HTTP request and WebSocket
// handshake needs the token: as `?token=` once (exchanged for a cookie, then redirected without
// it), via the login form, as `Authorization: Bearer <token>`, or as the session cookie.
// OBSERVATORY_PUBLIC_ORIGIN lists the public origins (e.g. https://agents.example.com) whose
// pages may post chat messages, next to the local ones.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';

export const COOKIE_NAME = 'observatory_session';
export const LOGIN_PATH = '/__login';
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const MIN_TOKEN_LENGTH = 16;
const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

export interface AuthConfig {
  token: string | null;
  publicOrigins: string[];
}

/** Reads the auth settings from the environment; throws on unusable values. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  let token = env.OBSERVATORY_TOKEN?.trim() || null;
  const file = env.OBSERVATORY_TOKEN_FILE?.trim();
  if (!token && file) token = fs.readFileSync(file, 'utf8').trim() || null;
  if (token !== null && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`OBSERVATORY_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return { token, publicOrigins: parseOrigins(env.OBSERVATORY_PUBLIC_ORIGIN ?? '') };
}

/** "https://a.example.com, https://b.example.com/" → normalized origins (https/http only). */
export function parseOrigins(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[\s,]+/).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error(`OBSERVATORY_PUBLIC_ORIGIN: not a URL: ${part}`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error(`OBSERVATORY_PUBLIC_ORIGIN: only http(s) origins: ${part}`);
    }
    out.push(u.origin);
  }
  return out;
}

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
function safeEqual(a: string, b: string) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function isLocalHost(host: string | undefined) {
  return LOCAL_HOST_RE.test(String(host ?? ''));
}

export class Auth {
  readonly enabled: boolean;
  readonly publicOrigins: string[];
  readonly #token: string;
  /** The cookie carries a value derived from the token, not the token itself. */
  readonly #session: string;

  constructor(config: AuthConfig) {
    this.enabled = config.token !== null;
    this.publicOrigins = config.publicOrigins;
    this.#token = config.token ?? '';
    this.#session = crypto
      .createHmac('sha256', this.#token)
      .update('observatory-session-v1')
      .digest('base64url');
  }

  checkToken(candidate: string | null | undefined) {
    return this.enabled && typeof candidate === 'string' && safeEqual(candidate, this.#token);
  }

  /** True when the request may proceed (auth disabled, valid cookie or bearer token). */
  isAuthorized(req: http.IncomingMessage) {
    if (!this.enabled) return true;
    const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (cookie !== undefined && safeEqual(cookie, this.#session)) return true;
    const m = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
    return m !== null && this.checkToken(m[1]);
  }

  /** Set-Cookie for a fresh login. Secure unless the page is served on a local http host. */
  sessionCookie(req: http.IncomingMessage) {
    const https =
      String(req.headers['x-forwarded-proto'] ?? '').startsWith('https') ||
      !isLocalHost(req.headers.host);
    return (
      `${COOKIE_NAME}=${this.#session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}` +
      (https ? '; Secure' : '')
    );
  }

  /** Origin of a page served under this public Host, or null when the Host is not public. */
  publicOriginFor(host: string | undefined): string[] {
    const h = String(host ?? '').toLowerCase();
    return this.publicOrigins.filter((o) => new URL(o).host === h);
  }

  /**
   * May this request write to an agent (chat)? Local pages as before (loopback peer, local Host,
   * local Origin if any); or, through a tunnel, a configured public Host with the exact matching
   * public Origin (always required there, so no cross-site posts).
   */
  isTrustedWrite(req: http.IncomingMessage, loopback: boolean) {
    if (!loopback) return false;
    const origin = req.headers.origin;
    if (isLocalHost(req.headers.host)) {
      if (origin === undefined) return true;
      try {
        return isLocalHost(new URL(origin).host);
      } catch {
        return false;
      }
    }
    const allowed = this.publicOriginFor(req.headers.host);
    return allowed.length > 0 && origin !== undefined && allowed.includes(origin);
  }

  /** WebSocket handshakes: same-page origins only (local, or configured public ones). */
  isAllowedSocketOrigin(req: http.IncomingMessage) {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // non-browser clients
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (isLocalHost(host)) return true;
    if (this.publicOrigins.includes(origin)) return true;
    // Served under some other name (e.g. a LAN host): allow only the page's own origin.
    return host === String(req.headers.host ?? '').toLowerCase();
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The themed "enter token" page. */
export function loginPage(opts: { error?: boolean; next?: string } = {}) {
  const next =
    opts.next && opts.next.startsWith('/') && !opts.next.startsWith('//') ? opts.next : '/';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Grok Coding Observatory</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e0f11;
    color: #ecebe6; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(380px, calc(100vw - 32px)); background: #18191c; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px; padding: 28px; box-shadow: 0 20px 60px rgb(0 0 0 / 0.45); }
  .mark { width: 40px; height: 40px; border-radius: 12px; background: #d4ff4f; display: grid;
    place-items: center; color: #12150a; font-weight: 800; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: #8d8f97; }
  label { display: block; font-size: 13px; color: #8d8f97; margin-bottom: 6px; }
  input { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);
    background: #141518; color: inherit; font: inherit; outline: none; }
  input:focus { border-color: #d4ff4f; box-shadow: 0 0 0 3px rgba(212,255,79,0.18); }
  button { margin-top: 14px; width: 100%; padding: 12px; border: 0; border-radius: 999px;
    background: #d4ff4f; color: #12150a; font: inherit; font-weight: 700; cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .error { color: #ff6b6b; margin: 10px 0 0; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">G</div>
  <h1>Grok Coding Observatory</h1>
  <p>This observatory is protected. Enter the access token to continue.</p>
  <form method="post" action="${LOGIN_PATH}">
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit">Sign in</button>
    ${opts.error ? '<p class="error" role="alert">That token is not valid.</p>' : ''}
  </form>
</main>
</body>
</html>
`;
}
