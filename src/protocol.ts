// The agent protocol version (docs/AGENT-PROTOCOL.md). Single source: package.json
// "observatory.protocolVersion", shared with the CLI (bin/status.mjs).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PROTOCOL_VERSION: number = pkg.observatory.protocolVersion;
export const PROTOCOL_DOC = 'docs/AGENT-PROTOCOL.md';
export const PROTOCOL_URL =
  'https://github.com/Eeliya/grok-coding-observatory/blob/main/docs/AGENT-PROTOCOL.md';

/** A protocol_version from a status file: a positive integer, else undefined. */
export function parseProtocolVersion(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : undefined;
}

/** Sent to the UI with every status snapshot (for the "reread the protocol" instruction). */
export const PROTOCOL_INFO = {
  version: PROTOCOL_VERSION,
  doc: fileURLToPath(new URL('../docs/AGENT-PROTOCOL.md', import.meta.url)),
  cli: fileURLToPath(new URL('../bin/status.mjs', import.meta.url)),
  url: PROTOCOL_URL,
};
