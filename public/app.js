/* Coding Observatory front end — vanilla JS (ES module) + Monaco from CDN. */
import { insertAt, nextChunkEnd, prepareHunk } from './replay.js';
import { changeSize, effectiveCps } from './playback-policy.js';
import { clampWidth, keyStep, panelBounds } from './panel-size.js';
import {
  countEditsByStep,
  editMatchesStep,
  planSummary,
  questionClipboard,
  questionCounts,
  openQuestions,
  renderPlanPanel,
  renderQuestionCards,
  stepBadge,
  stepTitle,
} from './plan-view.js';

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
// Code font size (px) for the editor and diff editors; adjustable in the header.
const FONT_KEY = 'observatory.fontSize';
const FONT_MIN = 8;
const FONT_MAX = 20;
const FONT_DEFAULT = 11;
let fontSize = Math.round(Number(localStorage.getItem(FONT_KEY)) || FONT_DEFAULT);
fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize));
const CODE_FONT = "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace";
const fontOptions = () => ({
  fontSize,
  lineHeight: Math.round(fontSize * 1.5),
  fontFamily: CODE_FONT,
});
const THEME = 'observatory';

/** Monaco theme matching style.css: vs-dark syntax colours on the app's surfaces. */
function defineTheme() {
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: 'comment', foreground: '7d8590', fontStyle: 'italic' }],
    colors: {
      'editor.background': '#141518',
      'editor.foreground': '#e3e2dc',
      'editorLineNumber.foreground': '#4a4c53',
      'editorLineNumber.activeForeground': '#d4ff4f',
      'editorCursor.foreground': '#d4ff4f',
      'editor.lineHighlightBackground': '#1b1c20',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#d4ff4f33',
      'editor.inactiveSelectionBackground': '#d4ff4f1f',
      'editor.findMatchHighlightBackground': '#f2c66d33',
      'editorIndentGuide.background1': '#ffffff0d',
      'editorIndentGuide.activeBackground1': '#ffffff24',
      'editorGutter.background': '#141518',
      'editorWidget.background': '#1f2024',
      'editorWidget.border': '#ffffff1a',
      'editorHoverWidget.background': '#1f2024',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff24',
      'scrollbarSlider.activeBackground': '#d4ff4f40',
      'minimap.background': '#141518',
      'minimapSlider.background': '#ffffff10',
      'editorOverviewRuler.border': '#00000000',
      'diffEditor.insertedTextBackground': '#5bd69a24',
      'diffEditor.removedTextBackground': '#ff6b6b30',
      'diffEditor.insertedLineBackground': '#5bd69a12',
      'diffEditor.removedLineBackground': '#ff6b6b17',
      'diffEditor.diagonalFill': '#ffffff0a',
      'diffEditor.border': '#ffffff10',
    },
  });
}

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
/** Lucide icon-font glyph (see lucide-static in index.html). */
const icon = (name, cls = '') =>
  `<i class="icon-${name}${cls ? ` ${cls}` : ''}" aria-hidden="true"></i>`;
// Agent status files (docs/AGENT-PROTOCOL.md), as last sent by the server.
const agentStatus = { agents: [], problems: [], log: [], offset: 0, staleTimer: 0 };
const state = {
  queue: [],
  playing: false,
  mode: 'live', // 'live' | 'diff' | 'history' | 'commit'
  files: [],
  current: null,
  target: null,
  gen: 0, // bumped on reset (branch switch / HEAD move) to abort stale playback
  token: 0, // bumped whenever the editor changes owner (live / diff / history view)
  paused: false,
  stepOnce: false, // play exactly one queued edit while paused
  stepping: false, // that single edit is playing now
  timeline: [], // session edits + HEAD markers (summaries), oldest first
  playedIds: new Set(), // edits already played live (or from before this page load)
  playingId: null, // edit currently animating live
  cursor: null, // timeline index shown in history mode
  speed: localStorage.getItem(SPEED_KEY) || 'fast',
};
if (!(state.speed in SPEEDS)) state.speed = 'fast';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chars/second right now: the chosen speed, fast-forwarded when the queue backs up.
// (History replays ignore the backlog.)
const cps = () =>
  state.mode === 'live'
    ? effectiveCps(SPEEDS[state.speed], state.queue.length)
    : state.mode === 'commit' && commits.instant
      ? Infinity
      : SPEEDS[state.speed];
const isInstant = () => cps() === Infinity;
// While paused, live playback freezes in place until resumed (or interrupted).
const frozen = () => state.paused && !state.stepping && state.mode === 'live';
async function hold(valid) {
  while (frozen() && valid()) await sleep(50);
}
// Pauses scale with speed so "turbo" feels snappy and "slow" is easy to follow.
async function pause(ms, valid = () => true) {
  await hold(valid);
  if (!isInstant()) await sleep(ms * (160 / Math.max(cps(), 160)) ** 0.5);
}
const TIMELINE_MAX = 500;
const SEEN_PREFIX = 'observatory.seen:';
const SEEN_CONTENT_MAX = 200_000; // chars of last-seen content kept for "since last look"
let seen = null; // { files: { [path]: { h, t, c? } } } for the current repo
let highlightTimer;

let monaco, editor, diffEditor, blankModel;
let decorations = null;
let caret = null;

// ------------------------------------------------------------------ UI

function setFontSize(px) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  localStorage.setItem(FONT_KEY, String(fontSize));
  $('font-size').textContent = `${fontSize}px`;
  $('font-dec').disabled = fontSize <= FONT_MIN;
  $('font-inc').disabled = fontSize >= FONT_MAX;
  editor?.updateOptions(fontOptions());
  diffEditor?.updateOptions(fontOptions()); // both sides of the diff (HEAD, commit, last look)
}

function setupFont() {
  $('font-dec').addEventListener('click', () => setFontSize(fontSize - 1));
  $('font-inc').addEventListener('click', () => setFontSize(fontSize + 1));
  $('font-size').addEventListener('click', () => setFontSize(FONT_DEFAULT));
  setFontSize(fontSize);
}

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
  const q = $('queue');
  q.innerHTML = state.paused ? `${icon('pause')} Paused · ${n} waiting` : n ? `${n} queued` : '';
  q.classList.toggle('paused', state.paused);
  $('live').innerHTML = `${icon('radio')} Live${n ? ` (${n} queued)` : ''}`;
  $('pause').innerHTML = icon(state.paused ? 'play' : 'pause');
  $('pause').title = state.paused ? 'Resume live playback (Space)' : 'Pause live playback (Space)';
  $('pause').classList.toggle('on', state.paused);
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
  if (isUnseen(f)) {
    li.classList.add('unseen');
    li.title += ' — changed since you last looked';
  }
  if (f.editedAt) {
    li.classList.add('recent');
    if (Date.now() - f.editedAt < FRESH_MS) li.classList.add('fresh');
    const mark = document.createElement('span');
    mark.className = 'edited';
    mark.innerHTML = icon('circle-dot');
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
  head.innerHTML = `${collapsible ? icon(open ? 'chevron-down' : 'chevron-right', 'chev') : ''}${esc(title)} (${files.length})`;
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
  const unseen = state.files.filter(isUnseen).length;
  $('unseen-bar').hidden = unseen === 0;
  $('unseen-count').textContent = `${unseen} unseen`;
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
  $('np-text').innerHTML = html;
}

// ------------------------------------------------------------------ progress bar

/**
 * Thin bar under the header: progress through what is playing now. `base`/`span`
 * map the current item's own 0..1 progress into the overall range (a commit's
 * file i of n covers [i/n, (i+1)/n]).
 */
const progress = { base: 0, span: 1, active: false, idleTimer: 0 };

function progressStart(label, base = 0, span = 1) {
  clearTimeout(progress.idleTimer);
  Object.assign(progress, { base, span, active: true });
  $('progress').classList.remove('idle');
  $('progress-label').textContent = label;
  $('progress-label').classList.remove('muted');
  itemProgress(0);
}

function itemProgress(f) {
  if (!progress.active) return;
  const v = progress.base + progress.span * Math.min(1, Math.max(0, f));
  $('progress-fill').style.width = `${(v * 100).toFixed(2)}%`;
  $('progress').dataset.value = v.toFixed(3);
}

/** Nothing playing: fade the bar out (optionally keeping a short muted note). */
function progressIdle(note = '', delay = 0) {
  progress.active = false;
  clearTimeout(progress.idleTimer);
  const go = () => {
    $('progress').classList.add('idle');
    $('progress').dataset.value = '';
    $('progress-fill').style.width = '0%';
    $('progress-label').textContent = note;
    $('progress-label').classList.add('muted');
  };
  if (delay) progress.idleTimer = setTimeout(go, delay);
  else go();
}

// Typing progress of the hunk being played: weights of done / current / all hunks.
let typing = { done: 0, weight: 0, total: 1 };
const reportTyping = (f) => itemProgress((typing.done + typing.weight * f) / typing.total);
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
      // Reconnected to a server that now watches another repo: reset like a switch.
      if (state.target && msg.target !== state.target) switchedRepo({ ...msg, files: [] });
      setTarget(msg.target);
      setHead(msg.head);
      if (!msg.target) openPicker();
    } else if (msg.type === 'reset') {
      handleReset(msg);
    } else if (msg.type === 'files') {
      state.files = msg.files;
      syncSeen();
      renderFiles();
    } else if (msg.type === 'history') {
      state.timeline = msg.items;
      state.playedIds = new Set(msg.items.map((i) => i.id)); // from before this page load
      renderTimeline();
    } else if (msg.type === 'status') {
      setAgentStatus(msg);
    } else if (msg.type === 'marker') {
      addToTimeline(msg.marker);
    } else if (msg.type === 'change') {
      msg.gen = state.gen;
      state.queue.push(msg);
      addToTimeline(summarize(msg));
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
  state.head = h;
  const el = $('branch');
  el.hidden = !h;
  if (!h) return;
  el.innerHTML = `${icon('git-branch')} ${esc(describeHead(h))}`;
  el.classList.toggle('detached', !!h.detached);
  el.title = h.detached ? 'Detached HEAD' : `Branch ${h.branch} at ${h.sha ?? '(no commits)'}`;
}

/** Branch switch / HEAD move: drop queued playback and reload from disk, no typing. */
async function handleReset(msg) {
  if (msg.reason === 'repo') return switchedRepo(msg);
  state.gen++;
  state.token++;
  state.queue = [];
  if (msg.marker) addToTimeline(msg.marker);
  commits.list = [];
  commits.loaded = false; // the branch history changed; reload on next use
  updateQueueLabel();
  setHead(msg.head);
  state.files = msg.files;
  syncSeen();
  renderFiles();
  if (!editor) return;
  if (state.mode === 'history') setMode('live');
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
  if (state.playing) return;
  state.playing = true;
  try {
    while (state.queue.length && state.mode === 'live' && (!state.paused || state.stepOnce)) {
      state.stepping = state.stepOnce;
      state.stepOnce = false;
      const ev = state.queue.shift();
      updateQueueLabel();
      const token = state.token;
      const valid = () => token === state.token && ev.gen === state.gen;
      state.playingId = ev.id;
      renderTimeline();
      progressStart(state.queue.length ? `edit · ${state.queue.length} waiting` : 'edit');
      let done = false;
      try {
        done = await play(ev, valid);
      } catch (err) {
        console.error('Playback failed', err);
        done = true; // don't retry a broken event forever
      }
      state.playingId = null;
      state.stepping = false;
      if (done) {
        state.playedIds.add(ev.id);
        markSeen(ev.path, ev.hash, ev.binary ? null : ev.after);
      } else if (ev.gen === state.gen) {
        // Interrupted by the diff/history view: play it again when back to live.
        state.queue.unshift(ev);
        updateQueueLabel();
      }
      renderTimeline();
    }
  } finally {
    state.playing = false;
    if (state.mode === 'live') progressIdle(state.paused && state.queue.length ? 'paused' : '');
  }
}

function modelFor(p, text, scheme = 'file') {
  const uri = monaco.Uri.from({ scheme, path: '/' + p });
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

/**
 * Animate one edit in the editor. `valid()` turns false when the editor is taken
 * over (diff/history view, reset); returns true only if the edit played to the end.
 */
async function play(ev, valid, { label } = {}) {
  if (!valid()) return false;
  const before = ev.before ?? '';
  const after = ev.after ?? '';
  const model = modelFor(ev.path, before, ev.type === 'commit-file' ? 'commit' : 'file');
  if (editor.getModel() !== model) editor.setModel(model);
  if (model.getValue() !== before) model.setValue(before);
  clearTimeout(highlightTimer);
  setDecorations([]);
  markActive(ev.path, true);
  const verb =
    label ??
    ({ created: 'Creating', deleted: 'Deleting', modified: 'Editing' }[ev.status] || 'Editing');
  const when = new Date(ev.ts).toLocaleTimeString();
  setNowPlaying(
    `${verb} <b>${esc(ev.path)}</b> · ${ev.hunks.length} hunk${ev.hunks.length === 1 ? '' : 's'} · ${when}`,
  );

  itemProgress(0);
  if (ev.binary) {
    setNowPlaying(`${verb} <b>${esc(ev.path)}</b> · changed (binary or too large to show)`);
    itemProgress(1);
    await pause(600, valid);
    return valid();
  }

  const queued = state.queue.length;
  const instantNote =
    ev.instant === 'generated'
      ? 'generated file — shown instantly'
      : ev.instant === 'large'
        ? `large change (${changeSize(ev.hunks).lines} lines) — shown instantly`
        : ev.instant === 'binary'
          ? 'binary or too large — shown instantly'
          : state.mode === 'commit' && commits.instant
            ? 'huge commit — shown instantly'
            : state.mode === 'live' && state.speed !== 'instant' && isInstant()
              ? `catching up (${queued} queued) — shown instantly`
              : null;
  if (ev.instant || isInstant()) {
    await hold(valid);
    if (!valid()) return false;
    model.setValue(after);
    itemProgress(1);
    const first = ev.hunks[0];
    if (first) editor.revealLineInCenter(Math.min(first.line, model.getLineCount()));
    const changed = ev.hunks
      .filter((h) => h.added.length)
      .map((h) => lineDeco(h.line, h.line + h.added.length - 1, 'line-added'));
    setDecorations(changed);
    if (instantNote) {
      setNowPlaying(
        `${verb} <b>${esc(ev.path)}</b> · <span class="note">${esc(instantNote)}</span> · ${when}`,
      );
      // Brief highlight of the changed region for big changes.
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        if (editor.getModel() === model) setDecorations([]);
      }, 2500);
    }
    // Short dwell so the viewer can see what changed, shorter while catching up.
    await sleep(state.queue.length ? 120 : 400);
    return valid();
  }
  if (cps() > SPEEDS[state.speed]) {
    setNowPlaying(
      `${$('np-text').innerHTML} · <span class="note">catching up ×${Math.round(cps() / SPEEDS[state.speed])}</span>`,
    );
  }

  const added = [];
  // Progress weight per hunk: characters to type, plus a little for showing removals.
  const weights = ev.hunks.map(
    (h) => h.added.reduce((n, l) => n + l.length + 1, 0) + (h.removed.length ? 20 : 0) + 1,
  );
  typing = { done: 0, weight: 0, total: weights.reduce((a, b) => a + b, 0) || 1 };
  for (const [k, h] of ev.hunks.entries()) {
    await hold(valid);
    if (!valid()) return false; // editor taken over: abandon this run
    typing.weight = weights[k];
    await playHunk(model, h, valid);
    typing.done += weights[k];
    typing.weight = 0;
    if (valid()) reportTyping(0);
    if (!valid()) return false;
    if (h.added.length) {
      added.push(lineDeco(h.line, h.line + h.added.length - 1, 'line-added'));
      setDecorations(added);
    }
    await pause(250, valid);
  }
  if (!valid()) return false;
  itemProgress(1);
  setCaret(null);
  // Safety net: guarantee the final buffer is byte-identical to the file.
  if (model.getValue() !== after) model.setValue(after);
  await pause(500, valid);
  return valid();
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
    await pause(Math.min(200 + r * 40, 900), live);
    if (!live()) return;
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
    if (frozen()) {
      await hold(live);
      last = performance.now();
    }
    if (!live()) return;
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
    reportTyping(i / text.length);
    setCaret(pos.lineNumber, pos.column);
    editor.revealPositionInCenterIfOutsideViewport(pos);
    await sleep(16);
  }
  setCaret(null);
}

// ------------------------------------------------------------------ diff view

async function showDiff(p, base = null) {
  setMode('diff');
  const token = state.token;
  markActive(p);
  setNowPlaying(`Diff · <b>${esc(p)}</b> <span class="muted">(live playback paused)</span>`);
  const res = await fetch(`/api/diff?path=${encodeURIComponent(p)}`);
  const data = await res.json();
  if (token !== state.token || state.current !== p) return;
  // Snapshot of what was seen before this look (opening the diff marks it seen).
  const prev = base && diffSeen.path === p ? diffSeen.prev : seen?.files[p];
  diffSeen = { path: p, prev };
  const canSince = !data.binary && prev?.c != null && prev.h !== data.currentHash;
  if (base !== 'seen' || !canSince) base = 'head';
  markSeen(p, data.currentHash, data.binary ? null : data.current);
  const btn = (b, text) =>
    `<button class="seg${base === b ? ' on' : ''}" data-base="${b}"${b === 'seen' && !canSince ? ' disabled title="No snapshot of an earlier look"' : ''}>${text}</button>`;
  setNowPlaying(
    `Diff · <b>${esc(p)}</b> ${btn('head', `${icon('git-compare')} vs HEAD`)}${btn('seen', `${icon('eye')} since last look`)} <span class="muted">— Esc for live</span>`,
  );
  for (const b of $('np-text').querySelectorAll('button.seg:not([disabled])')) {
    b.addEventListener('click', () => showDiff(p, b.dataset.base));
  }
  const text = (t) => (data.binary ? '(binary or too large to show)' : (t ?? ''));
  setDiff(p, base === 'seen' ? prev.c : text(data.head), text(data.current));
}

function setDiff(p, original, modified) {
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor($('diff'), {
      theme: THEME,
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      scrollBeyondLastLine: false,
      ...fontOptions(),
    });
  }
  const old = diffEditor.getModel();
  const lang = languageFor(p);
  diffEditor.setModel({
    original: monaco.editor.createModel(original, lang),
    modified: monaco.editor.createModel(modified, lang),
  });
  if (old) {
    old.original.dispose();
    old.modified.dispose();
  }
}
let diffSeen = { path: null, prev: null };

// ------------------------------------------------------------------ repo picker

const baseName = (p) => p.replace(/\/+$/, '').split('/').pop() || p;

function setTarget(target) {
  if (target !== state.target) loadSeen(target);
  state.target = target;
  $('repo-name').textContent = target ? baseName(target) : 'Choose repo…';
  $('repo').title = target
    ? `${target} — click to watch another repository`
    : 'Choose a repository';
  baseTitle = target ? `Observatory — ${baseName(target)}` : 'Coding Observatory';
  renderAgentStatus();
  $('empty').textContent = target
    ? 'No changes yet — waiting for edits…'
    : 'No repository selected — click “Choose repo…” above.';
}

/** The server switched to another repository: drop everything from the old one. */
function switchedRepo(msg) {
  state.gen++;
  state.token++;
  state.queue = [];
  state.timeline = [];
  state.playedIds = new Set();
  state.cursor = null;
  resetCommits();
  updateQueueLabel();
  renderTimeline();
  setTarget(msg.target);
  setHead(msg.head);
  state.files = msg.files;
  state.current = null;
  syncSeen();
  renderFiles();
  if (!editor) return;
  if (state.mode !== 'live') setMode('live');
  setDecorations([]);
  setCaret(null);
  editor.setModel(blankModel);
  for (const model of monaco.editor.getModels()) if (model.uri.scheme === 'file') model.dispose();
  setNowPlaying(
    `Now watching <b>${esc(baseName(msg.target))}</b> · ${esc(describeHead(msg.head))} <span class="muted">— waiting for edits…</span>`,
  );
  const el = $('repo');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

const picker = { data: null, busy: false };

function openPicker() {
  $('picker').hidden = false;
  $('picker-error').hidden = true;
  $('picker-path').value = '';
  $('picker-path').focus();
  renderPicker();
  loadRepos();
}

function closePicker() {
  $('picker').hidden = true;
}

async function loadRepos() {
  try {
    picker.data = await (await fetch('/api/repos')).json();
  } catch {
    picker.data = null;
  }
  renderPicker();
}

function pickerItem(repo, { current, missing }) {
  const li = document.createElement('li');
  li.dataset.path = repo.path;
  if (current) li.classList.add('current');
  if (missing) li.classList.add('missing');
  const name = document.createElement('span');
  name.className = 'repo-name';
  name.textContent = repo.name;
  const detail = document.createElement('span');
  detail.className = 'repo-path';
  detail.textContent = missing ? `${repo.path} (missing)` : repo.path;
  li.append(name, detail);
  if (repo.branch) {
    const b = document.createElement('span');
    b.className = 'repo-branch';
    b.textContent = repo.branch;
    li.append(b);
  }
  if (current) {
    const c = document.createElement('span');
    c.className = 'repo-current';
    c.textContent = 'watching';
    li.append(c);
  }
  if (!missing) li.addEventListener('click', () => chooseRepo(repo.path));
  return li;
}

function renderPicker() {
  const data = picker.data;
  const q = $('picker-path').value.trim().toLowerCase();
  const isPath = q.startsWith('/') || q.startsWith('~');
  const match = (r) => !q || isPath || r.path.toLowerCase().includes(q);
  const fill = (ul, repos, empty) => {
    ul.textContent = '';
    const shown = repos.filter(match);
    for (const r of shown)
      ul.append(pickerItem(r, { current: r.path === state.target, missing: r.exists === false }));
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = data ? empty : 'Loading…';
      ul.append(li);
    }
  };
  fill($('picker-recent'), data?.recent ?? [], 'No recent repositories yet.');
  fill($('picker-found'), data?.found ?? [], 'No git repositories found.');
  $('picker-found-title').textContent = data ? `Found in ${data.scanRoot}` : 'Found';
}

async function chooseRepo(p) {
  if (picker.busy) return;
  picker.busy = true;
  $('picker').classList.add('busy');
  $('picker-error').hidden = true;
  try {
    const res = await fetch('/api/target', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    closePicker();
  } catch (err) {
    $('picker-error').textContent = err.message;
    $('picker-error').hidden = false;
  } finally {
    picker.busy = false;
    $('picker').classList.remove('busy');
  }
}

function setupPicker() {
  $('repo').addEventListener('click', openPicker);
  $('picker-close').addEventListener('click', closePicker);
  $('picker').addEventListener('mousedown', (e) => {
    if (e.target === $('picker')) closePicker();
  });
  $('picker-path').addEventListener('input', renderPicker);
  $('picker-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('picker-path').value.trim();
    if (!v) return;
    const isPath = v.startsWith('/') || v.startsWith('~');
    const matches = [
      ...document.querySelectorAll('#picker .picker-list li[data-path]:not(.missing)'),
    ];
    const unique = [...new Set(matches.map((li) => li.dataset.path))];
    chooseRepo(!isPath && unique.length === 1 ? unique[0] : v);
  });
}

/** Switch between live playback, the diff view and the timeline (history) view. */
function setMode(mode, { pane = mode === 'diff' ? 'diff' : 'editor' } = {}) {
  state.mode = mode;
  state.token++; // interrupts whatever currently animates in the editor
  if (mode !== 'history') state.cursor = null;
  if (mode !== 'commit') {
    commits.index = -1;
    commits.detail = null;
    commits.fileIdx = -1;
    commits.instant = false;
  }
  commits.playing = false; // playCommit() sets it again after taking over
  progressIdle(); // whatever played is interrupted; the new owner restarts it
  $('commitbar').hidden = mode !== 'commit';
  $('live').hidden = mode === 'live';
  renderModeBar();
  $('diff').hidden = pane !== 'diff';
  $('editor').hidden = pane === 'diff';
  if (pane !== 'diff') editor?.layout();
  updateQueueLabel();
  renderTimeline();
}

function backToLive() {
  setMode('live');
  // Highlight the file actually shown in the editor, not the one opened in the diff view.
  const shown = editor.getModel();
  markActive(shown && shown.uri.scheme === 'file' ? shown.uri.path.slice(1) : null);
  setNowPlaying(
    state.paused
      ? `${icon('pause')} Paused — ${state.queue.length} waiting · Space to resume, → to step`
      : state.queue.length
        ? 'Resuming…'
        : 'Waiting for the assistant to edit something…',
  );
  pump();
}

// ------------------------------------------------------------------ timeline

function summarize(ev) {
  let plus = 0;
  let minus = 0;
  for (const h of ev.hunks) {
    plus += h.added.length;
    minus += h.removed.length;
  }
  return {
    type: 'edit',
    id: ev.id,
    ts: ev.ts,
    path: ev.path,
    status: ev.status,
    instant: ev.instant,
    plus,
    minus,
    ...(ev.step ? { step: ev.step } : {}),
  };
}

function addToTimeline(item) {
  state.timeline.push(item);
  if (state.timeline.length > TIMELINE_MAX) {
    const drop = state.timeline.length - TIMELINE_MAX;
    state.timeline.splice(0, drop);
    if (state.cursor != null) state.cursor = Math.max(0, state.cursor - drop);
  }
  renderTimeline();
}

const hhmmss = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });

function renderTimeline() {
  const strip = $('timeline-items');
  if (!strip) return;
  strip.textContent = '';
  state.timeline.forEach((item, index) => {
    const el = document.createElement('div');
    el.dataset.index = String(index);
    if (item.type === 'marker' && item.reason === 'agent' && item.kind) {
      // Plan step started / question asked: a small divider that groups the edits below it.
      const step = item.kind === 'step';
      el.className = `tl-marker tl-agent ${step ? 'tl-stepmark' : 'tl-qmark'}${item.blocking ? ' blocking' : ''}`;
      el.innerHTML = `${icon(step ? 'list-checks' : 'message-circle-question')} ${esc(item.message)}`;
      el.title = `${item.agent}: ${item.message} at ${hhmmss(item.ts)}`;
      if (step) {
        el.dataset.agent = item.agent;
        el.dataset.step = item.ref;
        el.addEventListener('click', () => togglePlanFilter(item.agent, item.ref));
      }
    } else if (item.type === 'marker' && item.reason === 'agent') {
      el.className = `tl-marker tl-agent ${item.state}`;
      const ic =
        { working: 'loader', done: 'circle-check', idle: 'circle' }[item.state] ?? 'circle';
      el.innerHTML = `${icon(ic)} ${item.agent && item.agent !== 'agent' ? `<b>${esc(item.agent)}</b> ` : ''}${esc(item.state === 'working' ? item.message || 'working' : [item.state, item.message].filter(Boolean).join(' · '))}`;
      el.title = `${item.agent}: ${item.state}${item.message ? ` — ${item.message}` : ''} at ${hhmmss(item.ts)}`;
    } else if (item.type === 'marker') {
      el.className = 'tl-marker';
      const sha = item.head?.sha;
      if (sha) {
        el.dataset.sha = sha;
        el.addEventListener('click', () => openCommit(sha));
        if (state.mode === 'commit' && commits.detail?.sha.startsWith(sha))
          el.classList.add('selected');
      }
      el.innerHTML =
        item.reason === 'branch'
          ? `${icon('git-branch')} ${esc(item.head.branch ?? item.head.sha ?? '')}`
          : `${icon('git-commit-horizontal')} ${esc(sha ?? '')}`;
      el.title = `${item.reason === 'branch' ? 'Switched to' : 'HEAD moved to'} ${describeHead(item.head)} at ${hhmmss(item.ts)}${sha ? ' — click to view this commit' : ''}`;
    } else {
      el.className = 'tl-edit';
      el.dataset.id = String(item.id);
      if (!state.playedIds.has(item.id)) el.classList.add('pending');
      if (item.id === state.playingId) el.classList.add('playing');
      if (state.mode === 'history' && index === state.cursor) el.classList.add('selected');
      if (state.planFilter)
        el.classList.add(editMatchesStep(item, state.planFilter) ? 'in-step' : 'dim');
      const name = document.createElement('span');
      name.className = 'tl-name';
      name.textContent = baseName(item.path);
      const meta = document.createElement('span');
      meta.className = 'tl-meta';
      meta.innerHTML = `${hhmmss(item.ts)} <span class="plus">+${item.plus}</span><span class="minus">−${item.minus}</span>${
        item.step
          ? `<span class="tl-step" title="${esc(stepTitle(item.step))}">${icon('list-checks')}${esc(stepBadge(item.step))}</span>`
          : ''
      }`;
      el.append(name, meta);
      el.title = `${item.path} · ${item.status} · ${hhmmss(item.ts)} · +${item.plus} −${item.minus}${item.instant ? ` · ${item.instant}` : ''}${item.step ? ` · ${stepTitle(item.step)}` : ''}`;
      el.addEventListener('click', () => viewEdit(index));
    }
    strip.append(el);
  });
  const edits = state.timeline.filter((i) => i.type === 'edit').length;
  $('timeline-count').textContent = `${edits} edit${edits === 1 ? '' : 's'}`;
  renderPlan(); // per-step edit counts
  const focus =
    (state.planFilter && strip.querySelector('.in-step')) ??
    strip.querySelector('.selected') ??
    strip.querySelector('.playing') ??
    strip.lastElementChild;
  focus?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Show exactly one past edit (its before → after) in the editor. */
async function viewEdit(index) {
  const item = state.timeline[index];
  if (!item || item.type !== 'edit' || !editor) return;
  setMode('history');
  state.cursor = index;
  renderTimeline();
  const token = state.token;
  const res = await fetch(`/api/history/${item.id}`);
  if (token !== state.token) return;
  if (!res.ok) {
    setNowPlaying(`Edit <b>${esc(item.path)}</b> is no longer in the server history`);
    return;
  }
  const ev = await res.json();
  const n = state.timeline.slice(0, index + 1).filter((i) => i.type === 'edit').length;
  progressStart(`replay #${n}`);
  const ok = await play(ev, () => token === state.token, { label: `Replaying edit ${n} ·` });
  if (ok) progressIdle('', 400);
}

const editIndices = () =>
  state.timeline.map((t, i) => (t.type === 'edit' ? i : -1)).filter((i) => i >= 0);

/** ←/→: step through the timeline; while paused in live mode, → plays the next queued edit. */
function step(dir) {
  if (state.mode === 'live' && dir > 0) {
    if (state.paused && state.queue.length && !state.playing) {
      state.stepOnce = true;
      pump();
    }
    return;
  }
  const idx = editIndices();
  if (!idx.length) return;
  let k;
  if (state.mode === 'history' && state.cursor != null) {
    k = idx.indexOf(state.cursor) + dir;
  } else {
    // From live/diff: ← shows the edit playing now, else the last one played.
    const cur = state.timeline.findIndex((t) => t.id === state.playingId);
    const played = idx.filter((i) => state.playedIds.has(state.timeline[i].id));
    k = idx.indexOf(cur >= 0 ? cur : (played.at(-1) ?? idx.at(-1)));
    if (dir > 0) k += 1;
  }
  if (k >= 0 && k < idx.length) viewEdit(idx[k]);
}

function togglePause() {
  state.paused = !state.paused;
  updateQueueLabel();
  if (state.mode === 'live') {
    if (state.paused && !state.playing) {
      setNowPlaying(
        `${icon('pause')} Paused — new edits wait in the queue · Space to resume, → to step`,
      );
    }
    if (!state.paused) {
      if (!state.playing && !state.queue.length) {
        setNowPlaying('Waiting for the assistant to edit something…');
      }
      pump();
    }
  }
}

// ------------------------------------------------------------------ seen tracking

function loadSeen(target) {
  seen = null;
  if (!target) return;
  try {
    const raw = localStorage.getItem(SEEN_PREFIX + target);
    seen = raw ? JSON.parse(raw) : null;
  } catch {
    seen = null;
  }
}

function saveSeen() {
  if (!state.target || !seen) return;
  const key = SEEN_PREFIX + state.target;
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    // Quota: keep hashes, drop the stored snapshots.
    for (const f of Object.values(seen.files)) delete f.c;
    try {
      localStorage.setItem(key, JSON.stringify(seen));
    } catch {
      /* give up silently */
    }
  }
}

/** First visit to a repo: everything currently changed counts as seen (baseline). */
function syncSeen() {
  if (!state.target) return;
  if (!seen) {
    seen = { files: {} };
    for (const f of state.files) if (f.hash) seen.files[f.path] = { h: f.hash, t: Date.now() };
  } else {
    // Forget files that are no longer changed (a later change counts as new).
    const live = new Set(state.files.map((f) => f.path));
    for (const p of Object.keys(seen.files)) if (!live.has(p)) delete seen.files[p];
  }
  saveSeen();
}

function isUnseen(f) {
  return !!(seen && f.hash && seen.files[f.path]?.h !== f.hash);
}

function markSeen(path, hash, content) {
  if (!state.target || !hash) return;
  seen ??= { files: {} };
  const entry = { h: hash, t: Date.now() };
  if (typeof content === 'string' && content.length <= SEEN_CONTENT_MAX) entry.c = content;
  seen.files[path] = entry;
  saveSeen();
  renderFiles();
}

function markAllSeen() {
  seen ??= { files: {} };
  for (const f of state.files) {
    if (!f.hash) continue;
    const prev = seen.files[f.path];
    seen.files[f.path] = prev?.h === f.hash ? prev : { h: f.hash, t: Date.now() };
  }
  saveSeen();
  renderFiles();
}

// ------------------------------------------------------------------ commit browser

/** Huge commits skip the typing animation entirely (per-file limits still apply below). */
const COMMIT_INSTANT_FILES = 40;
const COMMIT_INSTANT_LINES = 2000;
const COMMITS_PAGE = 50;
const commits = {
  list: [], // first-parent history of HEAD, newest first (loaded page by page)
  more: true,
  loaded: false,
  index: -1, // position of the shown commit in `list`
  detail: null, // GET /api/commit/:sha
  fileIdx: -1,
  instant: false,
  playing: false,
  where: '', // HEAD, HEAD~n or "not on <branch>"
  resumeAt: 0, // file index Play continues from (0 = from the start)
};

/** Header: which mode we are in, commit navigation and the commit's Play/Stop. */
function renderModeBar() {
  const mode = state.mode;
  const d = mode === 'commit' ? commits.detail : null;
  const pill = $('mode');
  pill.className = `mode mode-${mode}`;
  $('mode-live').hidden = mode !== 'live';
  $('mode-other').hidden = mode !== 'diff' && mode !== 'history';
  $('mode-other').innerHTML =
    mode === 'diff' ? `${icon('file-diff')} Diff` : `${icon('history')} Replay`;
  $('mode-commit').hidden = mode !== 'commit';
  if (mode === 'commit') {
    $('cb-sha').textContent = d?.short ?? '…';
    $('cb-sha').title = d?.sha ?? '';
    $('cb-subject').textContent = d ? d.subject || '(no message)' : 'loading…';
    $('cb-subject').title = d?.body ? `${d.subject}\n\n${d.body}` : (d?.subject ?? '');
    $('cb-pos').textContent = commits.where;
  }
  $('commit-prev').disabled = !!d && d.parents.length === 0;
  $('commit-prev').title =
    mode === 'commit'
      ? 'Older commit ([ or Shift+←)'
      : 'Browse commits: latest commit ([ or Shift+←)';
  $('commit-next').disabled = mode !== 'commit';
  $('commit-next').title =
    commits.index === 0 ? 'Back to live (] or Shift+→)' : 'Newer commit (] or Shift+→)';
  const play = $('cb-play');
  play.hidden = !d || !d.files.length;
  play.classList.toggle('on', commits.playing);
  play.innerHTML = commits.playing ? `${icon('square')} Stop` : `${icon('play')} Play`;
  play.title = commits.playing
    ? 'Stop playing this commit'
    : commits.resumeAt > 0
      ? `Resume from file ${commits.resumeAt + 1}/${d?.files.length ?? 0}`
      : 'Play this commit from the start';
}

function stopCommit() {
  if (state.mode !== 'commit' || !commits.playing) return;
  state.token++; // interrupts the running play() without leaving commit mode
  commits.playing = false;
  commits.resumeAt = Math.max(0, commits.fileIdx);
  setCaret(null);
  const n = commits.detail.files.length;
  progressIdle(`stopped · file ${commits.resumeAt + 1}/${n}`);
  setCommitNote(`stopped at file ${commits.resumeAt + 1}/${n} · Play to resume · Esc for live`);
  renderModeBar();
}

function toggleCommitPlay() {
  if (state.mode !== 'commit' || !commits.detail) return;
  if (commits.playing) stopCommit();
  else playCommit(commits.resumeAt);
}

function resetCommits() {
  Object.assign(commits, { list: [], more: true, loaded: false });
  if (state.mode === 'commit') setMode('live');
}

async function loadCommitPage() {
  const last = commits.loaded ? commits.list.at(-1) : null;
  if (commits.loaded && (!commits.more || !last)) return false;
  const q = new URLSearchParams({ limit: String(COMMITS_PAGE) });
  if (last) q.set('before', last.sha);
  const res = await fetch(`/api/commits?${q}`);
  if (!res.ok) return false;
  const data = await res.json();
  if (!commits.loaded) commits.list = [];
  commits.list.push(...data.commits);
  commits.more = data.more;
  commits.loaded = true;
  return data.commits.length > 0;
}

function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [name, secs] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

const FILE_ICONS = {
  added: 'file-plus',
  deleted: 'file-minus',
  renamed: 'file-symlink',
  copied: 'files',
  modified: 'file-pen',
  typechange: 'file-pen',
};

/** Index of the shown commit in the (possibly reloaded) list, -1 if not on this branch. */
const shownIndex = () =>
  commits.detail ? commits.list.findIndex((c) => c.sha === commits.detail.sha) : -1;

/** [ / Shift+←: older commit; ] / Shift+→: newer (from the newest commit: back to live). */
async function commitStep(dir) {
  if (!editor) return;
  if (!commits.loaded) await loadCommitPage();
  if (state.mode !== 'commit') {
    if (dir < 0 && commits.list.length) showCommit(0);
    return;
  }
  const i = shownIndex();
  if (dir > 0) {
    if (i <= 0) backToLive();
    else showCommit(i - 1);
    return;
  }
  if (i < 0) return;
  if (i + 1 >= commits.list.length) await loadCommitPage();
  if (i + 1 < commits.list.length) showCommit(i + 1);
  else setCommitNote('This is the first commit of the branch');
}

/** Jump to a commit by (short) sha, e.g. from a timeline marker. */
async function openCommit(sha) {
  if (!editor) return;
  if (!commits.loaded) await loadCommitPage();
  let i = commits.list.findIndex((c) => c.sha.startsWith(sha));
  for (let pages = 0; i < 0 && commits.more && pages < 10; pages++) {
    if (!(await loadCommitPage())) break;
    i = commits.list.findIndex((c) => c.sha.startsWith(sha));
  }
  if (i >= 0) return showCommit(i);
  // Not on the current branch's first-parent line (e.g. an old branch's HEAD): show it alone.
  const res = await fetch(`/api/commit/${encodeURIComponent(sha)}`);
  if (!res.ok) {
    setNowPlaying(`Commit <b>${esc(sha)}</b> is not in this repository any more`);
    return;
  }
  const detail = await res.json();
  enterCommit(detail, `not on ${state.head?.branch ?? 'this branch'}`);
}

async function showCommit(index) {
  const meta = commits.list[index];
  if (!meta) return;
  setMode('commit');
  commits.index = index;
  commits.detail = null;
  $('cb-files').textContent = '';
  $('cb-meta').textContent = '';
  const token = state.token;
  commits.where = index === 0 ? 'HEAD' : `HEAD~${index}`;
  renderModeBar();
  setNowPlaying(`${icon('git-commit-horizontal')} Loading <b>${esc(meta.short)}</b>…`);
  const res = await fetch(`/api/commit/${meta.sha}`);
  if (token !== state.token) return;
  if (!res.ok) return setNowPlaying(`Could not load commit <b>${esc(meta.short)}</b>`);
  enterCommit(await res.json(), index === 0 ? 'HEAD' : `HEAD~${index}`, token);
}

function enterCommit(detail, where, token = null) {
  if (token === null) {
    setMode('commit');
    token = state.token;
  }
  commits.detail = detail;
  commits.fileIdx = -1;
  commits.where = where;
  commits.resumeAt = 0;
  const lines = detail.files.reduce((n, f) => n + f.plus + f.minus, 0);
  commits.instant =
    detail.truncated || detail.files.length > COMMIT_INSTANT_FILES || lines > COMMIT_INSTANT_LINES;
  renderCommitBar();
  renderTimeline();
  playCommit(0);
}

function renderCommitBar() {
  const d = commits.detail;
  renderModeBar();
  const merge = d.parents.length > 1 ? ` · ${icon('git-merge')} merge (vs first parent)` : '';
  const root = d.parents.length === 0 ? ' · root commit' : '';
  $('cb-meta').innerHTML =
    `${icon('user')} ${esc(d.author)} · <span title="${esc(new Date(d.date).toLocaleString())}">${relTime(d.date)}</span>${merge}${root}`;
  const box = $('cb-files');
  box.textContent = '';
  d.files.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = `cb-file st-${f.status}`;
    el.dataset.index = String(i);
    el.innerHTML = `${icon(FILE_ICONS[f.status] ?? 'file')}<span class="cb-name"></span><span class="cb-stat">${
      f.binary
        ? 'bin'
        : `<span class="plus">+${f.plus}</span><span class="minus">−${f.minus}</span>`
    }</span>`;
    el.querySelector('.cb-name').textContent = baseName(f.path);
    el.title = `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} (${f.status}) — click for its diff`;
    el.addEventListener('click', () => showCommitFile(i));
    box.append(el);
  });
  if (d.truncated) {
    const more = document.createElement('span');
    more.className = 'muted';
    more.textContent = `… first ${d.files.length} files shown`;
    box.append(more);
  }
  if (!d.files.length) box.innerHTML = '<span class="muted">No file changes (empty commit)</span>';
}

function markCommitFile(i, cls) {
  for (const el of $('cb-files').querySelectorAll('.cb-file')) {
    el.classList.toggle(cls, Number(el.dataset.index) === i);
  }
  $('cb-files').querySelector(`.${cls}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setCommitNote(text) {
  setNowPlaying(
    `${icon('git-commit-horizontal')} <b>${esc(commits.detail?.short ?? '')}</b> · <span class="note">${esc(text)}</span>`,
  );
}

/** Replay the commit's diff (first parent → commit) file by file with the live engine. */
async function playCommit(from = 0) {
  const d = commits.detail;
  if (!d) return;
  setMode('commit', { pane: 'editor' });
  const token = state.token;
  const valid = () => token === state.token;
  const n = d.files.length;
  commits.playing = n > 0;
  commits.resumeAt = from;
  renderModeBar();
  for (let i = from; i < n; i++) {
    const f = d.files[i];
    commits.fileIdx = i;
    markCommitFile(i, 'playing');
    progressStart(`${i + 1}/${n} files`, i / n, 1 / n);
    const res = await fetch(`/api/commit/${d.sha}/file?path=${encodeURIComponent(f.path)}`);
    if (!valid()) return;
    if (!res.ok) continue;
    const ev = await res.json();
    const ok = await play(ev, valid, {
      label: `${icon('git-commit-horizontal')} ${esc(d.short)} · ${i + 1}/${n} ·`,
    });
    if (!ok) return;
  }
  if (!valid()) return;
  commits.playing = false;
  commits.resumeAt = 0;
  renderModeBar();
  if (n) {
    progressStart(`${n}/${n} files`);
    itemProgress(1);
    progressIdle(`${n}/${n} files`, 700);
  }
  markCommitFile(-1, 'playing');
  setCommitNote(
    d.files.length
      ? 'played · click a file for its diff · [ ] older/newer · Esc for live'
      : 'empty commit · [ ] older/newer · Esc for live',
  );
}

async function showCommitFile(i) {
  const d = commits.detail;
  const f = d?.files[i];
  if (!f) return;
  if (commits.playing) commits.resumeAt = Math.max(0, commits.fileIdx); // Play resumes here
  setMode('commit', { pane: 'diff' });
  const token = state.token;
  commits.fileIdx = i;
  markCommitFile(i, 'playing');
  const res = await fetch(`/api/commit/${d.sha}/file?path=${encodeURIComponent(f.path)}`);
  if (token !== state.token || !res.ok) return;
  const ev = await res.json();
  const text = (t) => (ev.binary ? '(binary or too large to show)' : t);
  setDiff(f.path, text(ev.before), text(ev.after));
  setNowPlaying(
    `${icon('file-diff')} <b>${esc(d.short)}</b> · <b>${esc(f.path)}</b>${f.oldPath ? ` <span class="muted">(from ${esc(f.oldPath)})</span>` : ''} <button class="seg" id="cb-replay">${icon('play')} play commit</button> <span class="muted">— Esc for live</span>`,
  );
  $('cb-replay').addEventListener('click', () => playCommit(0));
}

// ------------------------------------------------------------------ boot

setupSpeed();
setupFont();
$('live').addEventListener('click', backToLive);
$('pause').addEventListener('click', togglePause);
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('mark-seen').addEventListener('click', markAllSeen);
$('commit-prev').addEventListener('click', () => commitStep(-1));
$('commit-next').addEventListener('click', () => commitStep(1));
$('cb-play').addEventListener('click', toggleCommitPlay);
setupAgentStatus();
setupPicker();
// Capture phase, so the (read-only) editor can't swallow the shortcuts.
window.addEventListener(
  'keydown',
  (e) => {
    const t = e.target;
    const typing =
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      t.classList?.contains('resizer'); // a focused resize handle owns the arrow keys
    if (e.key === 'Escape') {
      if (!$('as-pop').hidden) toggleStatusPop(false);
      else if (!$('picker').hidden) closePicker();
      else if (state.mode !== 'live') backToLive();
      else if (state.paused) togglePause();
      return;
    }
    if (typing || !$('picker').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '[' || (e.shiftKey && e.key === 'ArrowLeft')) commitStep(-1);
    else if (e.key === ']' || (e.shiftKey && e.key === 'ArrowRight')) commitStep(1);
    else if (e.key === ' ') togglePause();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

// Right-hand session timeline: collapsible to a slim strip, remembered.
const TL_COLLAPSED_KEY = 'observatory.timelineCollapsed';
function setTimelineCollapsed(collapsed) {
  $('timeline').classList.toggle('collapsed', collapsed);
  const btn = $('tl-collapse');
  btn.innerHTML = icon(collapsed ? 'panel-right-open' : 'panel-right-close');
  btn.title = collapsed ? 'Show the session timeline' : 'Collapse the session timeline';
  btn.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem(TL_COLLAPSED_KEY, collapsed ? '1' : '0');
  if (!collapsed) renderTimeline();
}
function setupTimelineDock() {
  $('tl-collapse').addEventListener('click', () =>
    setTimelineCollapsed(!$('timeline').classList.contains('collapsed')),
  );
  setTimelineCollapsed(localStorage.getItem(TL_COLLAPSED_KEY) === '1');
}
setupTimelineDock();

// Resizable side panels: drag the handle in the gap, arrow keys on a focused handle,
// double-click (or Enter) resets to the CSS default. Widths are remembered per panel.
const RESIZERS = [
  {
    handle: 'side-resizer',
    panel: 'side',
    kind: 'side',
    other: 'timeline',
    prop: '--side-w',
    edge: 'right',
  },
  {
    handle: 'tl-resizer',
    panel: 'timeline',
    kind: 'timeline',
    other: 'side',
    prop: '--tl-w',
    edge: 'left',
  },
];
const widthKey = (kind) => `observatory.width.${kind}`;

function boundsFor(r) {
  const main = document.querySelector('main');
  const cs = getComputedStyle(main);
  const gap = parseFloat(cs.columnGap) || 0;
  const room =
    main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 * gap;
  return panelBounds(r.kind, room, $(r.other).getBoundingClientRect().width);
}

function setPanelWidth(r, width, { save = true } = {}) {
  const main = document.querySelector('main');
  const w = width == null ? null : clampWidth(width, boundsFor(r));
  if (w == null) main.style.removeProperty(r.prop);
  else main.style.setProperty(r.prop, `${w}px`);
  if (save) {
    if (w == null) localStorage.removeItem(widthKey(r.kind));
    else localStorage.setItem(widthKey(r.kind), String(w));
  }
  updateResizerAria(r);
}

/** The panel's width as set (not as measured mid-transition). */
function panelWidth(r) {
  const set = parseFloat(document.querySelector('main').style.getPropertyValue(r.prop));
  return set > 0 ? set : $(r.panel).getBoundingClientRect().width;
}

function updateResizerAria(r) {
  const b = boundsFor(r);
  const h = $(r.handle);
  h.setAttribute('aria-valuemin', String(b.min));
  h.setAttribute('aria-valuemax', String(b.max));
  h.setAttribute('aria-valuenow', String(Math.round(panelWidth(r))));
}

function setupResizers() {
  for (const r of RESIZERS) {
    const h = $(r.handle);
    h.addEventListener('pointerdown', (e) => {
      // No preventDefault: it would suppress mouse events and with them dblclick.
      // body.resizing (user-select: none) stops text selection instead.
      if (e.button !== 0) return;
      h.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = panelWidth(r);
      let moved = false;
      h.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 2) return;
        moved = true;
        setPanelWidth(r, startW + (r.edge === 'left' ? -dx : dx), { save: false });
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.classList.remove('dragging');
        document.body.classList.remove('resizing');
        if (moved) setPanelWidth(r, panelWidth(r));
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
      h.addEventListener('pointercancel', up, { once: true });
    });
    h.addEventListener('dblclick', () => setPanelWidth(r, null));
    h.addEventListener('keydown', (e) => {
      const w = panelWidth(r);
      let next = keyStep(w, e.key, e.shiftKey, r.edge);
      if (e.key === 'Home') next = boundsFor(r).min;
      else if (e.key === 'End') next = boundsFor(r).max;
      if (e.key === 'Enter') setPanelWidth(r, null);
      else if (next != null) setPanelWidth(r, next);
      else return;
      e.preventDefault();
    });
    const saved = localStorage.getItem(widthKey(r.kind));
    if (saved) setPanelWidth(r, saved, { save: false });
    else updateResizerAria(r);
  }
  // Re-clamp remembered widths when the window shrinks, so the editor keeps its room.
  window.addEventListener('resize', () => {
    for (const r of RESIZERS) {
      const saved = localStorage.getItem(widthKey(r.kind));
      if (saved) setPanelWidth(r, saved, { save: false });
      else updateResizerAria(r);
    }
  });
}
setupResizers();

// ------------------------------------------------------------------ agent status
// Agents report working/done/idle via files in the repo's git dir (docs/AGENT-PROTOCOL.md).

let baseTitle = document.title;

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Display state of one agent, with staleness judged against the server clock. */
function agentView(a) {
  const now = Date.now() + agentStatus.offset;
  const age = now - a.ts;
  const stale = a.state === 'working' && age > a.ttl * 1000;
  return { ...a, stale, ago: fmtAgo(age), view: stale ? 'stale' : a.state, old: age > 3600e3 };
}

function agentLabel(v, withName) {
  // The text part ellipsizes; the age stays readable.
  const who = withName ? `<b>${esc(v.agent)}</b> ` : '';
  const msg = v.message ? ` · ${esc(v.message)}` : '';
  const text = (t) => `<span class="as-text">${who}${t}</span>`;
  const age = (t) => `<span class="as-age">· ${t}</span>`;
  if (v.view === 'working')
    return `<span class="as-pulse"></span>${text(esc(v.message || 'Working…'))}`;
  if (v.view === 'stale')
    return `${icon('triangle-alert')}${text(`Possibly stalled${msg}`)}${age(`last seen ${v.ago}`)}`;
  if (v.view === 'done') return `${icon('circle-check')}${text(`Done${msg}`)}${age(v.ago)}`;
  return `<span class="as-idle"></span>${text('Idle')}`;
}

function setAgentStatus(msg) {
  agentStatus.agents = msg.agents ?? [];
  agentStatus.problems = msg.problems ?? [];
  agentStatus.log = msg.log ?? [];
  agentStatus.offset = (msg.serverTime ?? Date.now()) - Date.now();
  renderAgentStatus();
}

function renderAgentStatus() {
  const box = $('agent-status');
  const views = agentStatus.agents.map(agentView);
  // Most urgent first: working, stalled, done, idle.
  const rank = { working: 0, stale: 1, done: 2, idle: 3 };
  views.sort((a, b) => rank[a.view] - rank[b.view] || b.ts - a.ts);
  box.hidden = !views.length && !agentStatus.problems.length;
  const multi = views.length > 1 || views.some((v) => v.agent !== 'agent');
  const shown = views.slice(0, 3);
  const chip = $('as-chip');
  chip.innerHTML =
    shown
      .map(
        (v) =>
          `<span class="as-seg ${v.view}${v.old && v.view !== 'working' ? ' old' : ''}" data-agent="${esc(v.agent)}">${agentLabel(v, multi)}</span>`,
      )
      .join('') +
    (views.length > 3 ? `<span class="as-more">+${views.length - 3}</span>` : '') +
    questionBadge() +
    (agentStatus.problems.length
      ? `<span class="as-problem" title="A status file could not be read">${icon('file-warning')}</span>`
      : '');
  chip.title = views.length
    ? views
        .map(
          (v) =>
            `${v.agent}: ${v.view === 'stale' ? 'possibly stalled' : v.view}${v.message ? ` — ${v.message}` : ''} (${v.ago})`,
        )
        .join('\n') +
      questionTitle() +
      '\nClick for recent activity'
    : 'Agent status problems — click for details';
  // Flip to "possibly stalled" right when the next working status runs out, not on the next tick.
  clearTimeout(agentStatus.staleTimer);
  const now = Date.now() + agentStatus.offset;
  const due = views
    .filter((v) => v.view === 'working')
    .map((v) => v.ts + v.ttl * 1000 - now)
    .filter((ms) => ms >= 0 && ms < 2 ** 31 - 1);
  if (due.length) agentStatus.staleTimer = setTimeout(renderAgentStatus, Math.min(...due) + 50);
  renderPlan();
  renderQuestions();
  const top = views[0]?.view;
  const qc = questionCounts(agentStatus.agents);
  const prefix = qc.blocking
    ? '❓ '
    : ({ working: '⏳ ', stale: '⚠ ', done: '✓ ' }[top] ?? (qc.open ? '❓ ' : ''));
  document.title = prefix + baseTitle;
  if (!$('as-pop').hidden) {
    renderStatusPop(views);
    placeStatusPop();
  }
}

function renderStatusPop(views = agentStatus.agents.map(agentView)) {
  const agents = views
    .map((v) => {
      const sum = planSummary(v);
      const plan = sum
        ? `<li class="as-plan" title="${esc(sum.current ? `Current step: ${sum.current.title}` : 'No current step')}">${icon('list-checks')}<span class="as-msg">${
            sum.current
              ? `Step ${sum.current.n}/${sum.current.of}: ${esc(sum.current.title)}`
              : 'Plan'
          } · ${sum.done}/${sum.total} done</span></li>`
        : '';
      return `<li class="as-seg ${v.view}" title="${esc(`${v.agent}: ${v.view === 'stale' ? 'possibly stalled' : v.view}${v.message ? ` — ${v.message}` : ''} (${v.ago})`)}">${agentLabel(v, true)}</li>${plan}`;
    })
    .join('');
  const log = agentStatus.log
    .slice(-12)
    .reverse()
    .map((e) => {
      const ic =
        e.kind === 'step'
          ? 'list-checks'
          : e.kind === 'question'
            ? 'message-circle-question'
            : ({ working: 'loader', done: 'circle-check', idle: 'circle' }[e.state] ?? 'circle');
      const text = e.message || e.state;
      return `<li title="${esc(`${hhmmss(e.ts)} ${e.agent}: ${text}`)}"><span class="as-time">${hhmmss(e.ts)}</span>${icon(ic, e.kind ? `as-l-${e.kind}${e.blocking ? ' blocking' : ''}` : `as-l-${e.state}`)}<span class="as-msg"><b>${esc(e.agent)}</b> ${esc(text)}</span></li>`;
    })
    .join('');
  const qs = openQuestions(agentStatus.agents);
  const questions = qs
    .map(
      (q) =>
        `<li class="as-question${q.blocking ? ' blocking' : ''}" title="${esc(q.text)}">${icon(q.blocking ? 'octagon-pause' : 'message-circle-question')}<span class="as-msg">${q.agent !== 'agent' ? `<b>${esc(q.agent)}</b> ` : ''}${esc(q.text)}</span></li>`,
    )
    .join('');
  const problems = agentStatus.problems
    .map((p) => `<li class="as-bad">${icon('file-warning')}${esc(p.file)}: ${esc(p.error)}</li>`)
    .join('');
  $('as-pop').innerHTML =
    `<div class="as-h">Agents</div><ul>${agents || '<li class="muted">No status reported</li>'}</ul>` +
    (questions ? `<div class="as-h">Open questions</div><ul>${questions}</ul>` : '') +
    (problems ? `<div class="as-h">Problems</div><ul>${problems}</ul>` : '') +
    `<div class="as-h">Recent activity</div><ul class="as-log">${log || '<li class="muted">No changes since the server started</li>'}</ul>`;
}

function toggleStatusPop(open = $('as-pop').hidden) {
  $('as-pop').hidden = !open;
  $('as-chip').setAttribute('aria-expanded', String(open));
  if (open) {
    renderStatusPop();
    placeStatusPop();
  }
}

/** Keep the popup inside the viewport (it is anchored to the chip's right edge). */
function placeStatusPop() {
  const pop = $('as-pop');
  pop.style.right = '';
  const r = pop.getBoundingClientRect();
  const margin = 8;
  let shift = 0;
  if (r.left < margin) shift = r.left - margin;
  else if (r.right > innerWidth - margin) shift = r.right - (innerWidth - margin);
  if (shift) pop.style.right = `${shift}px`;
}

// ------------------------------------------------------------------ plan + questions

const PLAN_COLLAPSED_KEY = 'observatory.planCollapsed';
state.planFilter = null; // { agent, id }: highlight the edits of one plan step
state.planCollapsed = localStorage.getItem(PLAN_COLLAPSED_KEY) === '1';

function questionBadge() {
  const { open, blocking } = questionCounts(agentStatus.agents);
  if (!open) return '';
  const tip = `${open} open question${open === 1 ? '' : 's'}${blocking ? ` (${blocking} blocking)` : ''}`;
  return `<span class="as-q${blocking ? ' blocking' : ''}" title="${tip}">${icon(blocking ? 'octagon-pause' : 'message-circle-question')}${open}</span>`;
}

function questionTitle() {
  const { open, blocking } = questionCounts(agentStatus.agents);
  return open
    ? `\n${open} open question${open === 1 ? '' : 's'}${blocking ? `, ${blocking} blocking` : ''}`
    : '';
}

function renderPlan() {
  const box = $('plan');
  if (!box) return;
  // Drop a filter whose step no longer exists.
  const f = state.planFilter;
  if (
    f &&
    !agentStatus.agents.some((a) => a.agent === f.agent && a.plan?.some((s) => s.id === f.id))
  ) {
    state.planFilter = null;
  }
  const html = renderPlanPanel(agentStatus.agents, {
    collapsed: state.planCollapsed,
    filter: state.planFilter,
    counts: countEditsByStep(state.timeline),
  });
  box.hidden = !html;
  if (box.innerHTML !== html) box.innerHTML = html;
}

function renderQuestions() {
  const box = $('questions');
  if (!box) return;
  const html = renderQuestionCards(agentStatus.agents, Date.now() + agentStatus.offset);
  box.hidden = !html;
  if (box.innerHTML !== html) box.innerHTML = html;
}

function togglePlanFilter(agent, id) {
  const f = state.planFilter;
  state.planFilter = f && f.agent === agent && f.id === id ? null : { agent, id };
  renderTimeline();
}

function setupPlan() {
  const box = $('plan');
  const pick = (e) => {
    const li = e.target.closest('.ps');
    if (li) togglePlanFilter(li.dataset.agent, li.dataset.step);
  };
  box.addEventListener('click', (e) => {
    if (e.target.closest('.plan-head')) {
      state.planCollapsed = !state.planCollapsed;
      localStorage.setItem(PLAN_COLLAPSED_KEY, state.planCollapsed ? '1' : '0');
      renderPlan();
    } else if (e.target.closest('.plan-clear')) {
      state.planFilter = null;
      renderTimeline();
    } else pick(e);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (!e.target.closest('.ps')) return;
      e.preventDefault();
      pick(e);
    }
  });
  $('questions').addEventListener('click', async (e) => {
    const btn = e.target.closest('.q-copy');
    if (!btn) return;
    const card = btn.closest('.q-card');
    const q = openQuestions(agentStatus.agents).find(
      (x) => x.agent === card.dataset.agent && x.id === card.dataset.q,
    );
    if (!q) return;
    try {
      await navigator.clipboard.writeText(questionClipboard(q));
      btn.classList.add('copied');
      btn.lastChild.textContent = ' Copied';
    } catch {
      btn.lastChild.textContent = ' Copy failed';
    }
  });
}

function setupAgentStatus() {
  setupPlan();
  $('as-chip').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStatusPop();
  });
  document.addEventListener('click', (e) => {
    if (!$('as-pop').hidden && !$('agent-status').contains(e.target)) toggleStatusPop(false);
  });
  setInterval(renderAgentStatus, 5000); // "2m ago" ages move on without new messages
}

require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
require(['vs/editor/editor.main'], () => {
  monaco = window.monaco;
  // Explicit (not editor-owned) empty model, so it survives setModel() calls and
  // can be shown again after switching repos.
  defineTheme();
  blankModel = monaco.editor.createModel('', 'plaintext');
  editor = monaco.editor.create($('editor'), {
    model: blankModel,
    theme: THEME,
    readOnly: true,
    automaticLayout: true,
    ...fontOptions(),
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderLineHighlight: 'none',
  });
  connect();
});
