// Records the README demo (docs/demo.gif + an MP4 and a few stills): starts the observatory on a
// throwaway git repo, opens it in headless Chrome and lets a scripted fake "agent" edit files and
// report its status (docs/AGENT-PROTOCOL.md) while the screen is captured.
//
//   npm i --no-save puppeteer-core     # once; not a dependency of the app
//   node scripts/record-demo.mjs [outDir]   # default outDir: demo-out/
//
// Needs Chrome/Chromium (set CHROME=/path/to/chrome if it is not found), ffmpeg on PATH, and
// optionally gifski (smaller, crisper GIFs; falls back to ffmpeg's palettegen). Env: PORT (4499),
// WIDTH x HEIGHT (1280 x 800), FPS (12 for the GIF).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || 'demo-out');
const PORT = Number(process.env.PORT || 4499);
const WIDTH = Number(process.env.WIDTH || 1280);
const HEIGHT = Number(process.env.HEIGHT || 800);
const FPS = Number(process.env.FPS || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is missing: run `npm i --no-save puppeteer-core` first.');
  process.exit(1);
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const candidates = [
    ...names.flatMap((n) => dirs.map((d) => path.join(d, n))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Chrome not found: set CHROME=/path/to/chrome');
  return found;
}
function has(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ demo repo
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-demo-'));
const repo = path.join(tmp, 'shop-cart');
const W = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

const CART_V0 = `import { formatPrice } from './format.js';

export function createCart() {
  return { items: [] };
}

export function addItem(cart, name, price, qty = 1) {
  cart.items.push({ name, price, qty });
  return cart;
}

export function total(cart) {
  return cart.items.reduce((s, i) => s + i.price * i.qty, 0);
}

export function summary(cart) {
  return \`\${cart.items.length} items, \${formatPrice(total(cart))}\`;
}
`;
const CART_V1 = `import { formatPrice } from './format.js';

const DISCOUNTS = { WELCOME10: 0.1, SUMMER25: 0.25 };

export function createCart() {
  return { items: [], discount: 0 };
}

export function addItem(cart, name, price, qty = 1) {
  cart.items.push({ name, price, qty });
  return cart;
}

export function applyDiscount(cart, code) {
  const rate = DISCOUNTS[code.trim().toUpperCase()];
  if (rate === undefined) throw new Error(\`Unknown code: \${code}\`);
  cart.discount = rate;
  return cart;
}

export function total(cart) {
  const subtotal = cart.items.reduce((s, i) => s + i.price * i.qty, 0);
  return Math.round(subtotal * (1 - cart.discount) * 100) / 100;
}

export function summary(cart) {
  return \`\${cart.items.length} items, \${formatPrice(total(cart))}\`;
}
`;
const FORMAT_V0 = `export function formatPrice(amount) {
  return '$' + amount.toFixed(2);
}
`;
const FORMAT_V1 = `const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });

export function formatPrice(amount) {
  return euro.format(amount);
}
`;
const TEST_V1 = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, applyDiscount, createCart, total } from '../src/cart.js';

test('applies a discount code', () => {
  const cart = addItem(createCart(), 'Mug', 12, 2);
  applyDiscount(cart, 'welcome10');
  assert.equal(total(cart), 21.6);
});

test('rejects unknown codes', () => {
  assert.throws(() => applyDiscount(createCart(), 'FREE'), /Unknown/);
});
`;
const README_V0 = `# shop-cart

A tiny shopping cart module.
`;
const README_V1 = `# shop-cart

A tiny shopping cart module.

## Discount codes

Call \`applyDiscount(cart, 'WELCOME10')\` before \`total(cart)\`.
Codes are case-insensitive.
`;

fs.mkdirSync(repo);
git('init', '-q', '-b', 'main');
W('src/cart.js', CART_V0);
W('src/format.js', FORMAT_V0);
W('README.md', README_V0);
W('package.json', '{\n  "name": "shop-cart",\n  "type": "module"\n}\n');
git('add', '-A');
git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'Initial cart');

const statusDir = path.join(repo, '.git', 'observatory', 'status');
function status(state, message) {
  fs.mkdirSync(statusDir, { recursive: true });
  const file = path.join(statusDir, 'grok.json');
  const json = { state, message, agent: 'grok', ts: new Date().toISOString() };
  fs.writeFileSync(file + '.tmp', JSON.stringify(json));
  fs.renameSync(file + '.tmp', file);
}

// ------------------------------------------------------------------ server + browser
const server = spawn(
  process.execPath,
  [path.join(ROOT, 'scripts', 'node.cjs'), 'src/server.ts', repo],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      OBSERVATORY_CONFIG_DIR: path.join(tmp, 'config'),
      REPOS_ROOT: tmp,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (d) => {
    out += d;
    if (/Open http/.test(out)) resolve();
  });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars', '--force-color-profile=srgb'],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('observatory.speed', 'normal');
  localStorage.setItem('observatory.fontSize', '13');
});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.monaco-editor', { timeout: 30000 });
await sleep(1500);

// Capture every painted frame with its timestamp (Chrome's screencast), assembled at a fixed rate.
const framesDir = path.join(tmp, 'frames');
fs.mkdirSync(framesDir);
const frames = [];
const cdp = await page.createCDPSession();
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = path.join(framesDir, `f${String(frames.length).padStart(5, '0')}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', {
  format: 'png',
  maxWidth: WIDTH,
  maxHeight: HEIGHT,
  everyNthFrame: 1,
});
const t0 = Date.now() / 1000;
fs.mkdirSync(OUT, { recursive: true });
const still = (name) => page.screenshot({ path: path.join(OUT, name) });

// ------------------------------------------------------------------ the fake agent
await sleep(600);
status('working', 'Adding discount codes to the cart');
await sleep(900);
W('src/cart.js', CART_V1);
await sleep(4200);
await still('still-1-typing.png');
await sleep(800);
W('src/format.js', FORMAT_V1);
await sleep(2600);
W('test/cart.test.js', TEST_V1);
await sleep(1200);
status('working', 'Running tests');
await sleep(2400);
W('README.md', README_V1);
await sleep(1000);
await still('still-2-working.png');
await sleep(1200);
status('done', 'Discount codes added, 2 tests pass');
await sleep(2200);
await still('still-3-done.png');
await sleep(600);
const t1 = Date.now() / 1000;

await cdp.send('Page.stopScreencast');
await browser.close();
server.kill();

// ------------------------------------------------------------------ encode
// Frames hold until the next one; the last holds until the end of the recording.
const usable = frames.filter((f) => f.t <= t1 + 1);
const list = [];
usable.forEach((f, i) => {
  const next = i + 1 < usable.length ? usable[i + 1].t : Math.max(t1, f.t + 0.1);
  list.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(3)}`);
});
list.push(`file '${usable.at(-1).file}'`);
const concat = path.join(tmp, 'frames.txt');
fs.writeFileSync(concat, list.join('\n') + '\n');
console.log(`${usable.length} frames over ${(t1 - t0).toFixed(1)}s`);

const ff = (...args) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const mp4 = path.join(OUT, 'demo.mp4');
ff(
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  concat,
  '-vf',
  'fps=30,format=yuv420p',
  '-c:v',
  'libx264',
  '-crf',
  '20',
  '-preset',
  'slow',
  '-movflags',
  '+faststart',
  mp4,
);

const gif = path.join(OUT, 'demo.gif');
if (has('gifski')) {
  const gifFrames = path.join(tmp, 'gif');
  fs.mkdirSync(gifFrames);
  ff(
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concat,
    '-vf',
    `fps=${FPS}`,
    path.join(gifFrames, 'g%05d.png'),
  );
  const pngs = fs
    .readdirSync(gifFrames)
    .sort()
    .map((f) => path.join(gifFrames, f));
  execFileSync(
    'gifski',
    [
      '--quiet',
      '--fps',
      String(FPS),
      '--width',
      String(WIDTH),
      '--quality',
      '100',
      '-o',
      gif,
      ...pngs,
    ],
    {
      stdio: 'inherit',
    },
  );
} else {
  ff(
    '-i',
    mp4,
    '-vf',
    `fps=${FPS},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    gif,
  );
}
fs.rmSync(tmp, { recursive: true, force: true });
for (const f of fs.readdirSync(OUT)) {
  console.log(
    `${path.join(OUT, f)}  ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`,
  );
}
