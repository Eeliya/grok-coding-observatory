// @ts-check
/**
 * Playback policy: which changes are animated and how fast. All thresholds live
 * here and are shared by the server (tags each change event) and the browser
 * (applies queue fast-forward).
 *
 * @typedef {{ line: number, removed: string[], added: string[] }} Hunk
 */

/** A single change above either limit is shown instantly instead of typed. */
export const MAX_ANIMATED_LINES = 80; // removed + added lines
export const MAX_ANIMATED_CHARS = 4000; // removed + added characters

/** Queue fast-forward: from this many queued events on, type 4x faster... */
export const QUEUE_TURBO_AT = 3;
export const QUEUE_TURBO_FACTOR = 4;
/** ...and from this many on, show everything instantly until caught up. */
export const QUEUE_INSTANT_AT = 8;

/** Generated / lock / minified files: always shown instantly. */
export const GENERATED_FILE_PATTERNS = [
  /(^|\/)(package-lock|npm-shrinkwrap|composer|deno)\.json$/,
  /(^|\/)(yarn|composer|Gemfile|Cargo|poetry|Pipfile|flake|bun|mix|Podfile|packages)\.lock$/,
  /(^|\/)pnpm-lock\.ya?ml$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)go\.sum$/,
  /\.lock$/,
  /\.min\.(js|mjs|cjs|css)$/,
  /\.(js|css|mjs|cjs)\.map$/,
  /\.map$/,
  /\.snap$/,
  /\.generated\.[a-z]+$/,
];

/** @param {string} path repo-relative path */
export function isGeneratedFile(path) {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(path));
}

/** @param {Hunk[]} hunks */
export function changeSize(hunks) {
  let lines = 0;
  let chars = 0;
  for (const h of hunks) {
    lines += h.removed.length + h.added.length;
    for (const l of h.removed) chars += l.length + 1;
    for (const l of h.added) chars += l.length + 1;
  }
  return { lines, chars };
}

/**
 * Why a change should skip the typing animation, or null to animate it.
 * @param {string} path @param {Hunk[]} hunks
 * @returns {'generated' | 'large' | null}
 */
export function instantReason(path, hunks) {
  if (isGeneratedFile(path)) return 'generated';
  const { lines, chars } = changeSize(hunks);
  if (lines > MAX_ANIMATED_LINES || chars > MAX_ANIMATED_CHARS) return 'large';
  return null;
}

/**
 * Typing speed (chars/second) given the user's speed and the queue backlog.
 * Returns Infinity for "show instantly".
 * @param {number} baseCps @param {number} queued events still waiting
 */
export function effectiveCps(baseCps, queued) {
  if (queued >= QUEUE_INSTANT_AT) return Infinity;
  if (queued >= QUEUE_TURBO_AT) return baseCps * QUEUE_TURBO_FACTOR;
  return baseCps;
}
