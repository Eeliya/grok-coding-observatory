// Human → agent chat (inbox) and protocol-version helpers: pure functions shared by the UI
// (app.js) and the tests. They return plain data or HTML strings; no DOM access.
import { esc } from './plan-view.js';

const icon = (name, cls = '') =>
  `<i class="icon-${name}${cls ? ` ${cls}` : ''}" aria-hidden="true"></i>`;

export const MAX_CHAT_TEXT = 4000;

/** CLI invocation for an agent, e.g. `node /…/bin/status.mjs --agent grok`. */
export function cliCommand(protocol, agent) {
  const base = protocol?.cli ? `node ${protocol.cli}` : 'grok-observatory';
  return agent && agent !== 'agent' ? `${base} --agent ${agent}` : base;
}

/**
 * Whether an agent works with an older (or unknown) protocol than this observatory.
 * Returns null when it is current, else { level: 'missing' | 'old', text }.
 */
export function protocolNotice(a, protocol) {
  const current = protocol?.version;
  if (!current) return null;
  const v = a?.protocol_version;
  if (Number.isInteger(v) && v >= current) return null;
  return Number.isInteger(v)
    ? {
        level: 'old',
        text: `Agent read protocol v${v}; current is v${current} — ask it to reread docs/AGENT-PROTOCOL.md`,
      }
    : {
        level: 'missing',
        text: `Agent hasn't reported a protocol version; current is v${current} — ask it to read docs/AGENT-PROTOCOL.md`,
      };
}

/** The paragraph to paste into an agent's chat so it rereads and adopts the protocol. */
export function protocolInstruction(protocol, agent) {
  const S = cliCommand(protocol, agent);
  const doc = protocol?.doc ?? 'docs/AGENT-PROTOCOL.md';
  return (
    `Please reread the grok-coding-observatory agent protocol (v${protocol?.version ?? '?'}): ${doc}` +
    `${protocol?.url ? ` (online: ${protocol.url})` : ''} and follow it from now on. ` +
    `In short: before each step and between tool calls run \`${S} inbox\`; treat any messages it ` +
    `prints as instructions from me, answer them with \`${S} reply "…"\` (and in this chat), and ` +
    `resolve questions I answered there with \`${S} resolve <id>\`. Keep reporting status, plan and ` +
    `steps as described (mark each step done or skipped when you finish it). When you have read it, ` +
    `run \`${S} protocol ack\` so the observatory knows you use protocol v${protocol?.version ?? '?'}.`
  );
}

/**
 * Agents you can write to: those reporting status (most recently updated first), then those
 * that only have an inbox thread.
 */
export function chatTargets(agents, threads) {
  const byTs = [...(agents ?? [])].sort((a, b) => b.ts - a.ts).map((a) => a.agent);
  const extra = Object.keys(threads ?? {})
    .filter((n) => !byTs.includes(n))
    .sort();
  return [...byTs, ...extra];
}

/** Agent replies newer than `seenTs` (the human has not looked at them yet). */
export const unreadReplies = (thread, seenTs = 0) =>
  (thread ?? []).filter((m) => m.from === 'agent' && m.ts > seenTs).length;

/** The latest chat answer the human gave to a question ({ agent, id }), or null. */
export function questionAnswer(threads, agent, id) {
  const t = threads?.[agent] ?? [];
  for (let i = t.length - 1; i >= 0; i--) if (t[i].from === 'human' && t[i].re === id) return t[i];
  return null;
}

const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Read receipt of a human message. */
export function seenLabel(m, agent) {
  return m.seen
    ? { cls: 'seen', icon: 'check-check', text: `Seen by ${agent}` }
    : { cls: 'sent', icon: 'check', text: `Sent · ${agent} reads it when it checks its inbox` };
}

/**
 * Thread HTML for one agent. `questions` (that agent's open + known questions) lets an answer
 * quote the question it refers to.
 * @param {any[]} messages
 * @param {{ agent?: string, questions?: { id: string, text: string }[] }} [opts]
 */
export function renderThread(messages, { agent = 'agent', questions = [] } = {}) {
  if (!messages?.length) {
    return (
      `<div class="chat-empty">${icon('messages-square')}<p>No messages yet.</p>` +
      `<p class="muted">Messages wait in ${esc(agent)}'s inbox until it checks between steps ` +
      `(<code>inbox</code> in the protocol).</p></div>`
    );
  }
  const qText = new Map(questions.map((q) => [q.id, q.text]));
  let lastSeen = -1;
  messages.forEach((m, i) => {
    if (m.from === 'human' && m.seen) lastSeen = i;
  });
  return messages
    .map((m, i) => {
      const mine = m.from === 'human';
      const re = m.re
        ? `<div class="chat-re-quote" title="${esc(qText.get(m.re) ?? m.re)}">${icon('corner-down-right')}<span>${
            qText.has(m.re) ? esc(qText.get(m.re)) : `Question ${esc(m.re)}`
          }</span></div>`
        : '';
      let meta = `<time datetime="${new Date(m.ts).toISOString()}">${hhmm(m.ts)}</time>`;
      if (mine) {
        // A receipt on unread messages, and on the last one the agent has read.
        if (!m.seen || i === lastSeen) {
          const s = seenLabel(m, agent);
          meta += `<span class="chat-receipt ${s.cls}" title="${esc(s.text)}">${icon(s.icon)}${m.seen ? `Seen` : 'Sent'}</span>`;
        }
      } else meta = `<b>${esc(agent)}</b>${meta}`;
      return (
        `<div class="chat-msg ${mine ? 'from-human' : 'from-agent'}${mine && !m.seen ? ' unseen' : ''}" data-id="${esc(m.id)}">` +
        `${re}<div class="chat-bubble">${esc(m.text)}</div><div class="chat-meta">${meta}</div></div>`
      );
    })
    .join('');
}
