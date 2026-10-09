// Pure sizing rules for the resizable side panels (file list and session timeline).

/** Smallest width the editor between the panels may be squeezed to. */
export const STAGE_MIN = 420;

export const PANELS = {
  side: { min: 180, max: 520 },
  timeline: { min: 300, max: 760 },
};

/**
 * Bounds for one panel given the room in <main> (its inner width minus gaps) and the
 * other panel's current width, so the editor never drops below STAGE_MIN.
 */
export function panelBounds(kind, room, otherWidth) {
  const { min, max } = PANELS[kind];
  const fit = Math.floor(room - otherWidth - STAGE_MIN);
  return { min, max: Math.max(min, Math.min(max, fit)) };
}

/** Clamp a requested width to the bounds; non-numbers fall back to null (= CSS default). */
export function clampWidth(width, { min, max }) {
  const n = Number(width);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/** New width for a keyboard step on a handle; `edge` is the side of the panel the handle sits on. */
export function keyStep(width, key, shift, edge) {
  const step = shift ? 64 : 16;
  const grow = edge === 'left' ? 'ArrowLeft' : 'ArrowRight';
  const shrink = edge === 'left' ? 'ArrowRight' : 'ArrowLeft';
  if (key === grow) return width + step;
  if (key === shrink) return width - step;
  return null;
}
