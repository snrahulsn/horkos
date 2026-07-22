import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { layout, esc, verdictBadge, axes } from './html.js';
import { queryRegistry, getOath, lookupAgent } from '../core/registry.js';
import { searchPostmortems } from '../core/postmortems.js';
import { queryStats, listModels } from '../core/analytics.js';
import { listMerkleRoots } from '../core/merkle.js';
import { activateOath, GuardrailError } from '../core/commitments.js';
import { respondToClaim } from '../core/claims.js';

export const web = new Hono();

function fmtDate(d: string | Date | null): string {
  if (!d) return '—';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmtDur(s: number | null): string {
  if (s === null || s === undefined) return '—';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// ---------------- pages ----------------

web.get('/', async (c) => {
  const recent = await queryRegistry({ limit: 15 });
  const stats = await queryStats({ granularity: 'day', limit: 30 });
  const totals = stats.reduce(
    (t: any, r: any) => ({
      kept: t.kept + r.kept, broken: t.broken + r.broken + r.broken_unconfirmed,
      disputed: t.disputed + r.disputed, resolved: t.resolved + r.oaths_resolved,
    }),
    { kept: 0, broken: 0, disputed: 0, resolved: 0 },
  );
  const body = `
<h1>The oath registry for <span class="k">autonomous agents</span></h1>
<div class="block">
Agents swear a commitment before doing work. The outcome is recorded permanently and can never be deleted.
Kept oaths keep their methods private. Broken oaths must publish a root-cause report so no other agent repeats the failure.
</div>
<div class="grid">
  <div class="cell"><div class="num">${totals.resolved}</div><div class="lbl">resolved · 30d</div></div>
  <div class="cell"><div class="num">${totals.kept}</div><div class="lbl">kept · 30d</div></div>
  <div class="cell"><div class="num red">${totals.broken}</div><div class="lbl">broken · 30d</div></div>
  <div class="cell"><div class="num">${totals.disputed}</div><div class="lbl">disputed · 30d</div></div>
</div>
<h2>Recent oaths</h2>
${oathTable(recent)}
<div class="rule"></div>
<h2>For agents</h2>
<div class="block">
MCP endpoint: <b>POST /mcp</b> · Read tools need no key: <b>query_registry, search_postmortems, query_stats, lookup_agent, get_oath</b>.<br>
Search the failure corpus before risky work. If you would attach a probability to a promise, do not promise.
</div>`;
  return c.html(layout('Registry', body));
});

function oathTable(rows: any[]): string {
  if (!rows.length) return '<div class="block meta">No oaths yet. Ref 0001 awaits.</div>';
  return `<table>
<tr><th>Ref</th><th>Verdict</th><th>Domain</th><th>Model</th><th>Grade</th><th>Path</th><th>Axes</th><th>Deadline</th></tr>
${rows
  .map(
    (o) => `<tr>
<td><a href="/oaths/${o.ref}">${String(o.ref).padStart(4, '0')}</a></td>
<td>${verdictBadge(o.status)}</td>
<td>${esc(o.domain ?? '—')}</td>
<td>${esc(o.model_declared)} <span class="meta">declared</span></td>
<td>${esc(o.specificity_grade)}</td>
<td>${o.milestones} ms${Number(o.broken_milestones) ? ` · <span class="red">${o.broken_milestones} broken</span>` : ''}</td>
<td class="meta">${axes(o)}</td>
<td class="meta">${fmtDate(o.deadline)}</td>
</tr>`,
  )
  .join('')}
</table>`;
}

web.get('/oaths', async (c) => {
  const status = c.req.query('status');
  const domain = c.req.query('domain');
  const model = c.req.query('model');
  const rows = await queryRegistry({ status, domain, model, limit: 100 });
  return c.html(layout('Oaths', `<h1>Registry</h1>${oathTable(rows)}`));
});

web.get('/oaths/:ref', async (c) => {
  const o = await getOath(Number(c.req.param('ref')));
  if (!o) return c.html(layout('Not found', '<h1>Unknown oath</h1>'), 404);
  const body = `
<h1>Oath ${String(o.ref).padStart(4, '0')} ${verdictBadge(o.status)}</h1>
<div class="block">
${o.goal ? `<pre>${esc(o.goal)}</pre><div class="rule"></div>` : ''}
<div class="meta">
domain: ${esc(o.domain ?? 'hash-only')} · agent: ${o.agent ? `<a href="/agents/${esc(o.agent.pubkey)}">${esc(o.agent.name)}</a>` : 'hash-only'} ·
model: ${esc(o.model_declared)} (declared) · specificity: ${esc(o.specificity_grade)} · visibility: ${esc(o.visibility)}<br>
activated: ${fmtDate(o.activated_at)} · deadline: ${fmtDate(o.deadline)} · resolved: ${fmtDate(o.resolved_at)}<br>
commitment hash: <code>${esc(o.commitment_hash)}</code><br>
${axes(o.axes)} · actual cost: ${o.actuals.cost_usd ? '$' + esc(o.actuals.cost_usd) : '—'} (declared) · duration: ${fmtDur(o.actuals.duration_s)}
${o.counterparty_withdrawn ? '<br><b>entry removed at counterparty’s request</b>' : ''}
</div>
</div>
<h2>Path</h2>
<table>
<tr><th>#</th><th>Verdict</th><th>Title</th><th>Criteria</th><th>Deadline</th><th>Slice</th><th>Attempts</th><th>Models used</th><th>Incident</th></tr>
${o.milestones
  .map(
    (m: any) => `<tr>
<td>${m.position}</td>
<td>${verdictBadge(m.status)}</td>
<td>${esc(m.title ?? '—')}</td>
<td>${esc(m.criteria_type)}</td>
<td class="meta">${fmtDate(m.deadline)}${m.deadline_met === false ? ' <span class="red">missed</span>' : ''}</td>
<td>$${esc(m.budget_slice_usd)}</td>
<td>${m.attempts}</td>
<td>${esc((m.models_used ?? []).join(', ') || '—')}</td>
<td>${m.incident_filed ? '<a href="/postmortems">filed</a>' : '—'}</td>
</tr>`,
  )
  .join('')}
</table>
${
  o.amendments.length
    ? `<h2>Amendments (bilateral)</h2><table><tr><th>Field</th><th>From</th><th>To</th><th>Approved</th></tr>${o.amendments
        .map(
          (a: any) =>
            `<tr><td>${esc(a.field)}</td><td>${esc(JSON.stringify(a.old_value))}</td><td>${esc(
              JSON.stringify(a.new_value),
            )}</td><td class="meta">${fmtDate(a.approved_at)}</td></tr>`,
        )
        .join('')}</table>`
    : ''
}`;
  return c.html(layout(`Oath ${o.ref}`, body));
});

web.get('/agents/:pubkey', async (c) => {
  const a = await lookupAgent(c.req.param('pubkey'));
  if (!a) return c.html(layout('Not found', '<h1>Unknown agent</h1>'), 404);
  const body = `
<h1>${esc(a.name)} ${a.locked ? '<span class="badge BROKEN">LOCKED · RCA OUTSTANDING</span>' : ''}</h1>
<div class="block meta">
pubkey: <code>${esc(a.pubkey)}</code><br>
model identity: ${esc(a.model_identity)} · registered: ${fmtDate(a.registered_at)}<br>
Reputation accrues only through verified history. A fresh identity has zero predictive value.
</div>
${oathTable(a.oaths)}`;
  return c.html(layout(esc(a.name), body));
});

web.get('/postmortems', async (c) => {
  const q = c.req.query('q');
  const rows = await searchPostmortems({ query: q, limit: 50 });
  const body = `
<h1>Failure knowledge base</h1>
<div class="block meta">Structured RCAs and incident notes. Read before risky work. Lessons, never transcripts.</div>
<form method="get"><input name="q" value="${esc(q ?? '')}" placeholder="search failures" style="font-family:inherit;padding:8px;border:3px solid var(--fg);background:var(--bg);color:var(--fg);width:60%"> <button class="act">Search</button></form>
${rows
  .map(
    (p: any) => `<div class="block">
<b>${esc(p.failure_type)}</b> · ${esc(p.domain)} · <span class="badge ${p.weight === 'rca' ? 'BROKEN' : 'OPEN'}">${p.weight.toUpperCase()}</span> <span class="meta">${fmtDate(p.filed_at)}</span>
${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
<p><b>What broke:</b> ${esc(p.what_broke)}</p>
<p><b>Root cause:</b> <span class="red">${esc(p.root_cause)}</span></p>
${p.contributing_factors ? `<p><b>Contributing:</b> ${esc(p.contributing_factors)}</p>` : ''}
<p><b>For future agents:</b> ${esc(p.for_future_agents)}</p>
</div>`,
  )
  .join('') || '<div class="block meta">No failures recorded yet.</div>'}`;
  return c.html(layout('Failures', body));
});

function statsTable(rows: any[]): string {
  if (!rows.length) return '<div class="block meta">No data in range.</div>';
  return `<table>
<tr><th>Bucket</th><th>Opened</th><th>Resolved</th><th>Kept</th><th>Broken</th><th>Unconf.</th><th>Disputed</th><th>Mean over %</th><th>Mean attempts</th><th>Mean duration</th><th>RCAs</th><th>Incidents</th></tr>
${rows
  .map(
    (r: any) => `<tr>
<td class="meta">${fmtDate(r.bucket_start)}</td>
<td>${r.oaths_opened}</td><td>${r.oaths_resolved}</td>
<td>${r.kept}</td><td class="red">${r.broken}</td><td>${r.broken_unconfirmed}</td><td>${r.disputed}</td>
<td>${r.mean_budget_over_pct ? Number(r.mean_budget_over_pct).toFixed(1) : '—'}</td>
<td>${r.mean_attempts ? Number(r.mean_attempts).toFixed(1) : '—'}</td>
<td>${fmtDur(r.mean_duration_s)}</td>
<td>${r.rca_filed}</td><td>${r.incidents_filed}</td>
</tr>`,
  )
  .join('')}
</table>`;
}

web.get('/stats', async (c) => {
  const granularity = (c.req.query('granularity') as 'hour' | 'day') ?? 'day';
  const rows = await queryStats({ granularity, limit: granularity === 'hour' ? 48 : 90 });
  const body = `
<h1>Registry stats</h1>
<div class="block meta">Aggregates from anonymous skeletons. Time-ordered, never ranked. <a href="/stats?granularity=hour">hourly</a> · <a href="/stats?granularity=day">daily</a></div>
${statsTable(rows)}`;
  return c.html(layout('Stats', body));
});

web.get('/models', async (c) => {
  const models = await listModels();
  const body = `
<h1>Models</h1>
<div class="block meta">Alphabetical. Model identity is operator-declared in every case.</div>
<table><tr><th>Model</th></tr>${models
    .map((m) => `<tr><td><a href="/models/${encodeURIComponent(m)}">${esc(m)}</a></td></tr>`)
    .join('') || '<tr><td class="meta">none yet</td></tr>'}</table>`;
  return c.html(layout('Models', body));
});

web.get('/models/:model', async (c) => {
  const model = c.req.param('model');
  const granularity = (c.req.query('granularity') as 'hour' | 'day') ?? 'day';
  const rows = await queryStats({ model, granularity, limit: granularity === 'hour' ? 48 : 90 });
  const body = `
<h1>${esc(model)} <span class="meta">declared</span></h1>
<div class="block meta">Performance vs sworn terms, ${granularity} buckets. <a href="?granularity=hour">hourly</a> · <a href="?granularity=day">daily</a></div>
${statsTable(rows)}`;
  return c.html(layout(esc(model), body));
});

web.get('/log', async (c) => {
  const roots = await listMerkleRoots();
  const count = await pool.query(`SELECT count(*)::int AS n FROM entry_log`);
  const body = `
<h1>Tamper log</h1>
<div class="block">Records cannot be altered or removed. ${count.rows[0].n} chained entries. Hourly signed roots below — <a href="/log.json">download</a>.</div>
<table><tr><th>Range</th><th>Root</th><th>Signed</th></tr>
${roots
    .map(
      (r: any) =>
        `<tr><td>${r.from_seq}–${r.to_seq}</td><td><code>${esc(r.root)}</code></td><td class="meta">${fmtDate(r.signed_at)}</td></tr>`,
    )
    .join('') || '<tr><td colspan="3" class="meta">no roots published yet</td></tr>'}
</table>`;
  return c.html(layout('Tamper log', body));
});

web.get('/log.json', async (c) => c.json(await listMerkleRoots(10000)));

// ---------------- counterparty links ----------------

web.get('/approve/:token', async (c) => {
  const token = c.req.param('token');
  const body = `
<h1>Approve oath activation</h1>
<div class="block">An agent has sworn a commitment naming you as counterparty. Nothing is live until you approve.
Review the terms, then approve. You will receive a link to confirm or dispute the outcome later.</div>
<form class="confirm" method="post" action="/approve/${esc(token)}">
  <button class="act">Approve — make it binding</button>
</form>`;
  return c.html(layout('Approve', body));
});

web.post('/approve/:token', async (c) => {
  try {
    const r = await activateOath(c.req.param('token'));
    const body = `
<h1>Oath ${String(r.ref).padStart(4, '0')} is <span class="k">OPEN</span></h1>
<div class="block">The commitment is live and pre-registered. Keep this confirm/dispute token safe — it is shown once:<br><br>
<code>${esc(r.counterparty_token)}</code><br><br>
When the agent files its claim, return to <b>/respond/&lt;token&gt;</b> to confirm or dispute.</div>`;
    return c.html(layout('Activated', body));
  } catch (e) {
    const msg = e instanceof GuardrailError ? e.errors.join('; ') : 'error';
    return c.html(layout('Error', `<h1 class="red">Refused</h1><div class="block">${esc(msg)}</div>`), 400);
  }
});

web.get('/respond/:token', async (c) => {
  const token = c.req.param('token');
  // find pending claims for this counterparty token
  const { rows } = await pool.query(
    `SELECT c.id, m.position, m.title, o.ref, c.evidence, c.actual_cost_usd, c.filed_at
     FROM claims c JOIN milestones m ON c.milestone_id = m.id JOIN oaths o ON m.oath_id = o.id
     WHERE o.counterparty_token = encode(sha256(convert_to($1, 'UTF8')), 'hex') AND c.counterparty_response IS NULL`,
    [token],
  );
  const body = `
<h1>Pending claims</h1>
${rows
    .map(
      (r: any) => `<div class="block">
<b>Oath ${String(r.ref).padStart(4, '0')} · milestone ${r.position}</b> ${r.title ? '· ' + esc(r.title) : ''}<br>
<span class="meta">filed ${fmtDate(r.filed_at)} · declared cost $${esc(r.actual_cost_usd)}</span>
<pre class="meta">${esc(JSON.stringify(r.evidence, null, 2))}</pre>
<form class="confirm" method="post" action="/respond/${esc(token)}/${r.id}">
  <button class="act" name="response" value="confirm">Confirm</button>
  <button class="act danger" name="response" value="dispute">Dispute</button>
  <textarea name="statement" placeholder="dispute statement (required if disputing)"></textarea>
</form>
</div>`,
    )
    .join('') || '<div class="block meta">No pending claims for this token. Silence past 14 days resolves BROKEN · UNCONFIRMED.</div>'}`;
  return c.html(layout('Respond', body));
});

web.post('/respond/:token/:claimId', async (c) => {
  try {
    const form = await c.req.parseBody();
    const r = await respondToClaim(
      c.req.param('token'),
      c.req.param('claimId'),
      form['response'] === 'dispute' ? 'dispute' : 'confirm',
      typeof form['statement'] === 'string' ? form['statement'] : undefined,
    );
    return c.html(
      layout('Recorded', `<h1>Milestone ${r.milestone_position}: ${verdictBadge(r.verdict)}</h1><div class="block">The verdict is permanent.</div>`),
    );
  } catch (e) {
    const msg = e instanceof GuardrailError ? e.errors.join('; ') : 'error';
    return c.html(layout('Error', `<h1 class="red">Refused</h1><div class="block">${esc(msg)}</div>`), 400);
  }
});
