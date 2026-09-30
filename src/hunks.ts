import { diffArrays } from 'diff';

/**
 * A line-level change. Hunks are ordered top-to-bottom and `line` (1-based)
 * refers to the buffer AFTER all previous hunks have been applied, so a client
 * can replay them sequentially without offset bookkeeping:
 *   lines.splice(line - 1, removed.length, ...added)
 */
export interface Hunk {
  line: number;
  removed: string[];
  added: string[];
}

export function computeHunks(before: string, after: string): Hunk[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const hunks: Hunk[] = [];
  let line = 1;
  let cur: Hunk | null = null;
  const flush = () => {
    if (!cur) return;
    hunks.push(cur);
    line += cur.added.length;
    cur = null;
  };
  for (const change of diffArrays(a, b)) {
    if (!change.added && !change.removed) {
      flush();
      line += change.value.length;
      continue;
    }
    cur ??= { line, removed: [], added: [] };
    if (change.removed) cur.removed.push(...change.value);
    else cur.added.push(...change.value);
  }
  flush();
  return hunks;
}
