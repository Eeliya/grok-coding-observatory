// @ts-check
/**
 * Pure edit operations used to replay hunks. Shared by the browser (wrapping a
 * Monaco model) and the tests (wrapping a plain string), so what is tested is
 * exactly what runs in the page.
 *
 * @typedef {{ line: number, removed: string[], added: string[] }} Hunk
 * @typedef {{ lineNumber: number, column: number }} Pos
 * @typedef {object} EditModel
 * @property {() => number} getLineCount
 * @property {(line: number) => number} getLineMaxColumn
 * @property {(l1: number, c1: number, l2: number, c2: number, text: string) => void} edit
 */

/**
 * Delete `r` whole lines starting at line `L`. With `keepEmptyLine` one empty
 * line is left at `L` (to type the replacement into).
 * @param {EditModel} m @param {number} L @param {number} r @param {boolean} keepEmptyLine
 */
export function removeLines(m, L, r, keepEmptyLine) {
  const count = m.getLineCount();
  const end = L + r - 1;
  if (keepEmptyLine) m.edit(L, 1, end, m.getLineMaxColumn(end), '');
  else if (end < count) m.edit(L, 1, end + 1, 1, '');
  else if (L > 1) m.edit(L - 1, m.getLineMaxColumn(L - 1), end, m.getLineMaxColumn(end), '');
  else m.edit(1, 1, end, m.getLineMaxColumn(end), '');
}

/** Insert a new empty line so that it becomes line `L`. @param {EditModel} m @param {number} L */
export function openEmptyLine(m, L) {
  const count = m.getLineCount();
  if (L <= count) m.edit(L, 1, L, 1, '\n');
  else {
    const col = m.getLineMaxColumn(count);
    m.edit(count, col, count, col, '\n');
  }
}

/**
 * Insert `chunk` at `pos`; returns the position right after it.
 * @param {EditModel} m @param {Pos} pos @param {string} chunk @returns {Pos}
 */
export function insertAt(m, pos, chunk) {
  m.edit(pos.lineNumber, pos.column, pos.lineNumber, pos.column, chunk);
  const parts = chunk.split('\n');
  if (parts.length > 1) {
    return {
      lineNumber: pos.lineNumber + parts.length - 1,
      column: parts[parts.length - 1].length + 1,
    };
  }
  return { lineNumber: pos.lineNumber, column: pos.column + chunk.length };
}

/**
 * End index for the next typed chunk of `n` chars starting at `i`. Leading
 * indentation is swallowed instantly (like auto-indent) and surrogate pairs
 * are never split.
 * @param {string} text @param {number} i @param {number} n
 */
export function nextChunkEnd(text, i, n) {
  let end = Math.min(text.length, i + Math.max(1, n));
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end < text.length) end++;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t') && inIndent(text, end))
    end++;
  return end;
}

/** @param {string} text @param {number} i */
function inIndent(text, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (text[j] === '\n') return true;
    if (text[j] !== ' ' && text[j] !== '\t') return false;
  }
  return true;
}

/**
 * Prepare the buffer for hunk `h`: remove its old lines and leave an empty line
 * at `h.line` when there is text to type. Returns the text to type there.
 * @param {EditModel} m @param {Hunk} h
 */
export function prepareHunk(m, h) {
  const r = h.removed.length;
  const a = h.added.length;
  if (r > 0) removeLines(m, h.line, r, a > 0);
  else if (a > 0) openEmptyLine(m, h.line);
  return a > 0 ? h.added.join('\n') : '';
}

/**
 * Apply a hunk in one go, typing in `chunkSize` pieces (used by tests).
 * @param {EditModel} m @param {Hunk} h @param {number} [chunkSize]
 */
export function applyHunk(m, h, chunkSize = Infinity) {
  const text = prepareHunk(m, h);
  let pos = { lineNumber: h.line, column: 1 };
  for (let i = 0; i < text.length;) {
    const end = nextChunkEnd(text, i, Math.min(chunkSize, text.length));
    pos = insertAt(m, pos, text.slice(i, end));
    i = end;
  }
}

/** A plain-string EditModel. @param {string} initial */
export function stringModel(initial) {
  let text = initial;
  const lines = () => text.split('\n');
  /** @param {number} l @param {number} c */
  const offset = (l, c) => {
    const ls = lines();
    let o = 0;
    for (let i = 0; i < l - 1; i++) o += ls[i].length + 1;
    return o + c - 1;
  };
  return {
    getLineCount: () => lines().length,
    getLineMaxColumn: (/** @type {number} */ l) => lines()[l - 1].length + 1,
    edit(
      /** @type {number} */ l1,
      /** @type {number} */ c1,
      /** @type {number} */ l2,
      /** @type {number} */ c2,
      /** @type {string} */ t,
    ) {
      text = text.slice(0, offset(l1, c1)) + t + text.slice(offset(l2, c2));
    },
    getValue: () => text,
  };
}
