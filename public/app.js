/* Coding Observatory front end — vanilla JS (ES module) + Monaco from CDN. */
import { insertAt, nextChunkEnd, prepareHunk } from './replay.js';
import { changeSize, effectiveCps } from './playback-policy.js';

const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';

// Monaco web workers must be same-origin; bootstrap them through a data: URL.
window.MonacoEnvironment = {
  getWorkerUrl() {
    const src = `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`;
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`;
  },
};

// Characters typed per second for each speed.
const SPEEDS = { slow: 40, normal: 160, fast: 700, turbo: 3000, instant: Infinity };
const SPEED_KEY = 'observatory.speed';

const LANGS = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  pl: 'perl',
  bat: 'bat',
  hbs: 'handlebars',
};
const FILENAMES = { dockerfile: 'dockerfile', makefile: 'shell', '.gitignore': 'ini' };

function languageFor(p) {
  const base = p.split('/').pop().toLowerCase();
  if (FILENAMES[base]) return FILENAMES[base];
  if (base.startsWith('.env')) return 'ini';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return LANGS[ext] || 'plaintext';
}

const $ = (id) => document.getElementById(id);
const state = {
  queue: [],
  playing: false,
  mode: 'live', // 'live' | 'diff'
  files: [],
  current: null,
  gen: 0, // bumped on reset (branch switch / HEAD move) to abort stale playback
  speed: localStorage.getItem(SPEED_KEY) || 'fast',
};
if (!(state.speed in SPEEDS)) state.speed = 'fast';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chars/second right now: the chosen speed, fast-forwarded when the queue backs up.
const cps = () => effectiveCps(SPEEDS[state.speed], state.queue.length);
const isInstant = () => state.mode !== 'live' || cps() === Infinity;
// Pauses scale with speed so "turbo" feels snappy and "slow" is easy to follow.
const pause = (ms) => (isInstant() ? 0 : sleep(ms * (160 / Math.max(cps(), 160)) ** 0.5));
let highlightTimer;

let monaco, editor, diffEditor;
let decorations = null;
let caret = null;

// ------------------------------------------------------------------ UI

function setupSpeed() {
  const sel = $('speed');
  sel.value = state.speed;
  sel.addEventListener('change', () => {
    state.speed = sel.value;
    localStorage.setItem(SPEED_KEY, state.speed);
  });
}

function updateQueueLabel() {
  const n = state.queue.length;
  $('queue').textContent = n ? `${n} queued` : '';
  $('live').textContent = n ? `● Back to live (${n} queued)` : '● Back to live';
}

const BADGES = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R' };
const UNTRACKED_OPEN_KEY = 'observatory.untrackedOpen';
const FRESH_MS = 60_000;
let untrackedOpen = localStorage.getItem(UNTRACKED_OPEN_KEY) === '1'; // collapsed by default

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

function fileItem(f) {
  const li = document.createElement('li');
  li.className = `st-${f.status}`;
  li.dataset.path = f.path;
  if (f.path === state.current) li.classList.add('active');
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = BADGES[f.status] || '?';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = f.path;
  li.append(badge, name);
  li.title = `${f.path} (${f.status})`;
  if (f.editedAt) {
    li.classList.add('recent');
    if (Date.now() - f.editedAt < FRESH_MS) li.classList.add('fresh');
    const mark = document.createElement('span');
    mark.className = 'edited';
    mark.textContent = '●';
    li.append(mark);
    li.title += ` — edited live ${timeAgo(f.editedAt)}`;
  }
  li.addEventListener('click', () => showDiff(f.path));
  return li;
}

function fileGroup(title, files, { collapsible = false, open = true, onToggle } = {}) {
  const group = document.createElement('div');
  group.className = 'group';
  const head = document.createElement('div');
  head.className = 'group-title' + (collapsible ? ' collapsible' : '');
  const edited = files.filter((f) => f.editedAt).length;
  head.textContent = `${collapsible ? (open ? '▾ ' : '▸ ') : ''}${title} (${files.length})`;
  if (edited) {
    const e = document.createElement('span');
    e.className = 'group-edited';
    e.textContent = ` · ${edited} edited`;
    head.append(e);
  }
  if (collapsible) head.addEventListener('click', onToggle);
  const ul = document.createElement('ul');
  ul.className = 'file-list';
  // When collapsed, still show files that were edited live (they are real edits).
  const shown = open ? files : files.filter((f) => f.editedAt);
  for (const f of shown) ul.append(fileItem(f));
  group.append(head, ul);
  return group;
}

function renderFiles() {
  const root = $('files');
  root.textContent = '';
  const changed = state.files.filter((f) => f.category !== 'untracked');
  const untracked = state.files.filter((f) => f.category === 'untracked');
  if (changed.length || !untracked.length) root.append(fileGroup('Changed', changed));
  if (untracked.length) {
    root.append(
      fileGroup('Untracked', untracked, {
        collapsible: true,
        open: untrackedOpen,
        onToggle: () => {
          untrackedOpen = !untrackedOpen;
          localStorage.setItem(UNTRACKED_OPEN_KEY, untrackedOpen ? '1' : '0');
          renderFiles();
        },
      }),
    );
  }
  $('empty').hidden = state.files.length > 0;
}
setInterval(() => state.files.some((f) => f.editedAt) && renderFiles(), 15_000);

function markActive(p, pulse = false) {
  state.current = p;
  for (const li of $('files').querySelectorAll('li[data-path]')) {
    li.classList.toggle('active', li.dataset.path === p);
    if (pulse && li.dataset.path === p) {
      li.classList.remove('pulse');
      void li.offsetWidth;
      li.classList.add('pulse');
    }
  }
}

function setNowPlaying(html) {
  $('nowplaying').innerHTML = html;
}
const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ websocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => $('dot').classList.add('on');
  ws.onclose = () => {
    $('dot').classList.remove('on');
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') {
      $('target').textContent = msg.target;
      document.title = `Observatory — ${msg.target.split('/').pop()}`;
      setHead(msg.head);
    } else if (msg.type === 'reset') {
      handleReset(msg);
    } else if (msg.type === 'files') {
      state.files = msg.files;
      renderFiles();
    } else if (msg.type === 'change') {
      msg.gen = state.gen;
      state.queue.push(msg);
      updateQueueLabel();
      pump();
    }
  };
}

// ------------------------------------------------------------------ git HEAD

function describeHead(h) {
  if (!h) return '';
  if (h.detached) return `detached · ${h.sha ?? '?'}`;
  return `${h.branch} · ${h.sha ?? 'no commits'}`;
}

function setHead(h) {
  const el = $('branch');
  el.hidden = !h;
  if (!h) return;
  el.textContent = `⎇ ${describeHead(h)}`;
  el.classList.toggle('detached', !!h.detached);
  el.title = h.detached ? 'Detached HEAD' : `Branch ${h.branch} at ${h.sha ?? '(no commits)'}`;
}

/** Branch switch / HEAD move: drop queued playback and reload from disk, no typing. */
async function handleReset(msg) {
  state.gen++;
  state.queue = [];
  updateQueueLabel();
  setHead(msg.head);
  state.files = msg.files;
  renderFiles();
  if (!editor) return;
  setDecorations([]);
  setCaret(null);
  const label =
    msg.reason === 'branch'
      ? `Switched to <b>${esc(describeHead(msg.head))}</b>`
      : `HEAD moved to <b>${esc(describeHead(msg.head))}</b>`;
  setNowPlaying(`${label} <span class="muted">— reset, not replayed</span>`);
  const el = $('branch');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  // Forget cached file models (they hold pre-switch content); reload the visible one.
  const visible = editor.getModel();
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'file' && model !== visible) model.dispose();
  }
  if (visible && visible.uri.scheme === 'file') {
    const p = visible.uri.path.slice(1);
    const d = await (await fetch(`/api/diff?path=${encodeURIComponent(p)}`)).json();
    if (!d.binary && visible.getValue() !== (d.current ?? '')) visible.setValue(d.current ?? '');
  }
  if (state.mode === 'diff' && state.current) showDiff(state.current);
}

// ------------------------------------------------------------------ playback

async function pump() {
  if (state.playing || state.mode !== 'live') return;
  state.playing = true;
  try {
    while (state.queue.length && state.mode === 'live') {
      const ev = state.queue.shift();
      updateQueueLabel();
      try {
        await play(ev);
      } catch (err) {
        console.error('Playback failed', err);
      }
    }
  } finally {
    state.playing = false;
  }
}

function modelFor(p, text) {
  const uri = monaco.Uri.from({ scheme: 'file', path: '/' + p });
  let model = monaco.editor.getModel(uri);
  if (!model) model = monaco.editor.createModel(text, languageFor(p), uri);
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  return model;
}

function setDecorations(list) {
  if (!decorations) decorations = editor.createDecorationsCollection();
  decorations.set(list);
}

function lineDeco(from, to, className) {
  return {
    range: new monaco.Range(from, 1, to, 1),
    options: {
      isWholeLine: true,
      className,
      linesDecorationsClassName: className === 'line-added' ? 'gutter-added' : undefined,
    },
  };
}

function setCaret(line, col) {
  if (!caret) caret = editor.createDecorationsCollection();
  caret.set(
    line
      ? [
          {
            range: new monaco.Range(line, col, line, col),
            options: { beforeContentClassName: 'typing-caret' },
          },
        ]
      : [],
  );
}

async function play(ev) {
  if (ev.gen !== state.gen) return;
  const before = ev.before ?? '';
  const after = ev.after ?? '';
  const model = modelFor(ev.path, before);
  if (editor.getModel() !== model) editor.setModel(model);
  if (model.getValue() !== before) model.setValue(before);
  clearTimeout(highlightTimer);
  setDecorations([]);
  markActive(ev.path, true);
  const verb =
    { created: 'Creating', deleted: 'Deleting', modified: 'Editing' }[ev.status] || 'Editing';
  setNowPlaying(
    `${verb} <b>${esc(ev.path)}</b> · ${ev.hunks.length} hunk${ev.hunks.length === 1 ? '' : 's'} · ${new Date(ev.ts).toLocaleTimeString()}`,
  );

  if (ev.binary) {
    setNowPlaying(`<b>${esc(ev.path)}</b> changed (binary or too large to show)`);
    await pause(600);
    return;
  }

  const queued = state.queue.length;
  const instantNote =
    ev.instant === 'generated'
      ? 'generated file — shown instantly'
      : ev.instant === 'large'
        ? `large change (${changeSize(ev.hunks).lines} lines) — shown instantly`
        : state.mode === 'live' && state.speed !== 'instant' && isInstant()
          ? `catching up (${queued} queued) — shown instantly`
          : null;
  if (ev.instant || isInstant()) {
    model.setValue(after);
    const first = ev.hunks[0];
    if (first) editor.revealLineInCenter(Math.min(first.line, model.getLineCount()));
    const changed = ev.hunks
      .filter((h) => h.added.length)
      .map((h) => lineDeco(h.line, h.line + h.added.length - 1, 'line-added'));
    setDecorations(changed);
    if (instantNote) {
      setNowPlaying(
        `${verb} <b>${esc(ev.path)}</b> · <span class="note">${esc(instantNote)}</span> · ${new Date(ev.ts).toLocaleTimeString()}`,
      );
      // Brief highlight of the changed region for big changes.
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        if (editor.getModel() === model) setDecorations([]);
      }, 2500);
    }
    // Short dwell so the viewer can see what changed, shorter while catching up.
    if (state.mode === 'live') await sleep(state.queue.length ? 120 : 400);
    return;
  }
  if (cps() > SPEEDS[state.speed]) {
    setNowPlaying(
      `${$('nowplaying').innerHTML} · <span class="note">catching up ×${Math.round(cps() / SPEEDS[state.speed])}</span>`,
    );
  }

  const added = [];
  const live = () => ev.gen === state.gen;
  for (const h of ev.hunks) {
    if (!live()) return; // reset while playing: abandon this event
    await playHunk(model, h, live);
    if (h.added.length) {
      added.push(lineDeco(h.line, h.line + h.added.length - 1, 'line-added'));
      setDecorations(added);
    }
    await pause(250);
  }
  setCaret(null);
  if (!live()) return;
  // Safety net: guarantee the final buffer is byte-identical to the file.
  if (model.getValue() !== after) model.setValue(after);
  await pause(500);
}

/** Wrap a Monaco model in the EditModel interface used by replay.js. */
function adapt(model) {
  return {
    getLineCount: () => model.getLineCount(),
    getLineMaxColumn: (l) => model.getLineMaxColumn(l),
    edit: (l1, c1, l2, c2, text) =>
      model.applyEdits([{ range: new monaco.Range(l1, c1, l2, c2), text }]),
  };
}

async function playHunk(model, h, live) {
  const L = h.line;
  const r = h.removed.length;
  editor.revealLineInCenterIfOutsideViewport(Math.min(L, model.getLineCount()));
  if (r > 0) {
    setDecorations([lineDeco(L, L + r - 1, 'line-removed')]);
    await pause(Math.min(200 + r * 40, 900));
    setDecorations([]);
  }
  if (!live()) return;
  const m = adapt(model);
  const text = prepareHunk(m, h);
  if (text) await typeText(m, L, text, live);
}

async function typeText(m, startLine, text, live) {
  let pos = { lineNumber: startLine, column: 1 };
  let i = 0;
  let last = performance.now();
  let carry = 0;
  while (i < text.length) {
    if (!live()) break;
    if (isInstant()) {
      insertAt(m, pos, text.slice(i));
      break;
    }
    // Elapsed-time based so background-tab timer throttling just types bigger chunks.
    const now = performance.now();
    carry += ((now - last) / 1000) * cps();
    last = now;
    const n = Math.max(1, Math.floor(carry));
    carry = Math.max(0, carry - n);
    const end = nextChunkEnd(text, i, n);
    pos = insertAt(m, pos, text.slice(i, end));
    i = end;
    setCaret(pos.lineNumber, pos.column);
    editor.revealPositionInCenterIfOutsideViewport(pos);
    await sleep(16);
  }
  setCaret(null);
}

// ------------------------------------------------------------------ diff view

async function showDiff(p) {
  state.mode = 'diff';
  $('live').hidden = false;
  updateQueueLabel();
  markActive(p);
  setNowPlaying(
    `Diff vs HEAD · <b>${esc(p)}</b> <span class="muted">(live playback paused)</span>`,
  );
  const res = await fetch(`/api/diff?path=${encodeURIComponent(p)}`);
  const data = await res.json();
  if (state.mode !== 'diff' || state.current !== p) return;
  $('editor').hidden = true;
  $('diff').hidden = false;
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor($('diff'), {
      theme: 'vs-dark',
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      scrollBeyondLastLine: false,
    });
  }
  const old = diffEditor.getModel();
  const lang = languageFor(p);
  const text = (t) => (data.binary ? '(binary or too large to show)' : (t ?? ''));
  diffEditor.setModel({
    original: monaco.editor.createModel(text(data.head), lang),
    modified: monaco.editor.createModel(text(data.current), lang),
  });
  if (old) {
    old.original.dispose();
    old.modified.dispose();
  }
}

function backToLive() {
  state.mode = 'live';
  $('live').hidden = true;
  $('diff').hidden = true;
  $('editor').hidden = false;
  editor.layout();
  // Highlight the file actually shown in the editor, not the one opened in the diff view.
  const shown = editor.getModel();
  markActive(shown && shown.uri.scheme === 'file' ? shown.uri.path.slice(1) : null);
  setNowPlaying(state.queue.length ? 'Resuming…' : 'Waiting for the assistant to edit something…');
  pump();
}

// ------------------------------------------------------------------ boot

setupSpeed();
$('live').addEventListener('click', backToLive);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.mode === 'diff') backToLive();
});

require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
require(['vs/editor/editor.main'], () => {
  monaco = window.monaco;
  editor = monaco.editor.create($('editor'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    readOnly: true,
    automaticLayout: true,
    fontSize: 12,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderLineHighlight: 'none',
  });
  connect();
});
