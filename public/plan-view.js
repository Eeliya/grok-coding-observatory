// Agent plan, step attribution and open questions: pure helpers shared by the UI (app.js)
// and the tests. Everything here returns plain data or HTML strings; no DOM access.

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const icon = (name, cls = '') =>
  `<i class="icon-${name}${cls ? ` ${cls}` : ''}" aria-hidden="true"></i>`;

export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STEP_ICONS = {
  done: 'circle-check',
  active: 'circle-dot',
  pending: 'circle',
  skipped: 'circle-slash',
};

/** Key identifying one step of one agent (filters and per-step edit counts). */
export const stepKey = (agent, id) => `${agent}\u0000${id}`;

/** Done/total counts and the current step of an agent's plan (null without a plan). */
export function planSummary(a) {
  const plan = Array.isArray(a?.plan) ? a.plan : [];
  if (!plan.length) return null;
  const done = plan.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const i = plan.findIndex((s) => s.id === a.step);
  const current =
    i >= 0 ? { id: plan[i].id, title: plan[i].title, n: i + 1, of: plan.length } : null;
  return { done, total: plan.length, current };
}

/** Agents with a plan, the working (most recently updated) ones first. */
export function agentsWithPlans(agents) {
  const rank = { working: 0, done: 1, idle: 2 };
  return (agents ?? [])
    .filter((a) => Array.isArray(a.plan) && a.plan.length)
    .sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || b.ts - a.ts);
}

/** Number of timeline edits per step (keyed by stepKey). */
export function countEditsByStep(timeline) {
  const counts = new Map();
  for (const it of timeline ?? []) {
    if (it.type !== 'edit' || !it.step) continue;
    const k = stepKey(it.step.agent, it.step.id);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Whether a timeline edit belongs to the step filter ({ agent, id }); no filter = all. */
export const editMatchesStep = (item, filter) =>
  !filter || (!!item?.step && item.step.agent === filter.agent && item.step.id === filter.id);

/** Short label for an edit's step badge, e.g. "2". */
export const stepBadge = (step) => (step ? String(step.n) : '');

/** Tooltip for an edit's step badge. */
export const stepTitle = (step) =>
  step
    ? `Step ${step.n}/${step.of}: ${step.title}${step.agent !== 'agent' ? ` (${step.agent})` : ''}`
    : '';

/**
 * Plan panel HTML (empty string when no agent publishes a plan).
 * opts: { collapsed, filter: { agent, id } | null, counts: Map }
 */
export function renderPlanPanel(agents, opts = {}) {
  const withPlans = agentsWithPlans(agents);
  if (!withPlans.length) return '';
  const { collapsed = false, filter = null, counts = new Map() } = opts;
  const multi = withPlans.length > 1 || withPlans.some((a) => a.agent !== 'agent');
  const sections = withPlans.map((a) => {
    const sum = planSummary(a);
    const pct = Math.round((100 * sum.done) / sum.total);
    const steps = a.plan
      .map((s, i) => {
        const k = stepKey(a.agent, s.id);
        const n = counts.get(k) ?? 0;
        const selected = filter && filter.agent === a.agent && filter.id === s.id;
        const cur = s.id === a.step;
        const tip = `Step ${i + 1}: ${s.title} (${s.state}${cur ? ', current' : ''})${s.note ? ` — ${s.note}` : ''}${
          n ? ` · ${n} edit${n === 1 ? '' : 's'} — click to highlight them` : ''
        }`;
        return (
          `<li class="ps ps-${esc(s.state)}${cur ? ' ps-current' : ''}${selected ? ' selected' : ''}" ` +
          `data-agent="${esc(a.agent)}" data-step="${esc(s.id)}" title="${esc(tip)}" tabindex="0" role="button">` +
          `${icon(STEP_ICONS[s.state] ?? 'circle', 'ps-icon')}` +
          `<span class="ps-n">${i + 1}</span>` +
          `<span class="ps-title">${esc(s.title)}${s.note && cur ? `<span class="ps-note">${esc(s.note)}</span>` : ''}</span>` +
          (n ? `<span class="ps-count">${n}</span>` : '') +
          `</li>`
        );
      })
      .join('');
    return (
      `<div class="plan-agent" data-agent="${esc(a.agent)}">` +
      `<div class="plan-meta">${multi ? `<b>${esc(a.agent)}</b>` : ''}` +
      `<span class="plan-prog" title="${sum.done} of ${sum.total} steps done or skipped">${sum.done}/${sum.total} done</span></div>` +
      `<div class="plan-bar" aria-hidden="true"><div style="width:${pct}%"></div></div>` +
      `<ol class="plan-steps">${steps}</ol></div>`
    );
  });
  const first = planSummary(withPlans[0]);
  const headInfo = first.current
    ? `Step ${first.current.n}/${first.current.of}`
    : `${first.done}/${first.total}`;
  const filterBar = filter
    ? `<div class="plan-filter">${icon('filter')} Highlighting edits of step ${esc(
        (withPlans.find((a) => a.agent === filter.agent)?.plan ?? []).findIndex(
          (s) => s.id === filter.id,
        ) + 1 || '?',
      )} <button class="plan-clear" type="button">Show all</button></div>`
    : '';
  return (
    `<button class="plan-head" type="button" aria-expanded="${!collapsed}" title="${
      collapsed ? 'Show' : 'Hide'
    } the agent's plan">${icon(collapsed ? 'chevron-right' : 'chevron-down', 'chev')}` +
    `${icon('list-checks')}<span class="plan-label">Plan</span><span class="plan-head-info">${esc(headInfo)}</span></button>` +
    (collapsed ? '' : `<div class="plan-body">${sections.join('')}${filterBar}</div>`)
  );
}

/** All open questions, blocking first, then oldest first. */
export function openQuestions(agents) {
  const out = [];
  for (const a of agents ?? []) {
    for (const q of a.questions ?? []) out.push({ agent: a.agent, ...q });
  }
  return out.sort((x, y) => Number(!!y.blocking) - Number(!!x.blocking) || x.askedAt - y.askedAt);
}

export function questionCounts(agents) {
  const qs = openQuestions(agents);
  return { open: qs.length, blocking: qs.filter((q) => q.blocking).length };
}

/** Plain text for the "Copy" button: paste it into the agent's chat with your answer. */
export function questionClipboard(q) {
  const who = q.agent && q.agent !== 'agent' ? q.agent : 'The agent';
  const opts = (q.options ?? []).map((o, i) => `  ${i + 1}. ${o}`).join('\n');
  return `${who} asked: ${q.text}${opts ? `\nOptions:\n${opts}` : ''}\nMy answer: `;
}

/** Question cards HTML ('' when there are none). `now` is the server-adjusted clock. */
export function renderQuestionCards(agents, now = Date.now()) {
  const qs = openQuestions(agents);
  if (!qs.length) return '';
  return qs
    .map((q) => {
      const who = q.agent && q.agent !== 'agent' ? `<b>${esc(q.agent)}</b> asks` : 'The agent asks';
      const opts = (q.options ?? []).length
        ? `<ol class="q-opts">${q.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>`
        : '';
      const asked = new Date(q.askedAt);
      return (
        `<div class="q-card${q.blocking ? ' blocking' : ''}" data-agent="${esc(q.agent)}" data-q="${esc(q.id)}" role="note">` +
        `<div class="q-head">${icon(q.blocking ? 'octagon-pause' : 'message-circle-question', 'q-icon')}` +
        `<span class="q-who">${who}</span>` +
        (q.blocking
          ? `<span class="q-block" title="The agent is waiting for your answer">Blocking</span>`
          : '') +
        `<span class="q-ago" title="Asked at ${esc(asked.toLocaleString())}">asked ${esc(fmtAgo(now - q.askedAt))}</span>` +
        `<button class="q-copy" type="button" title="Copy the question (and options) to paste into the agent's chat">${icon('copy')} Copy</button>` +
        `</div>` +
        `<div class="q-text">${esc(q.text)}</div>${opts}` +
        `<div class="q-hint">Answer in your chat with the agent; this card stays until it marks the question resolved.</div>` +
        `</div>`
      );
    })
    .join('');
}
