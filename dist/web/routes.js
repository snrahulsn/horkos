import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { layout, esc, verdictBadge, axes } from './html.js';
import { queryRegistry, getOath, lookupAgent } from '../core/registry.js';
import { searchPostmortems } from '../core/postmortems.js';
import { queryStats, listModels } from '../core/analytics.js';
import { listMerkleRoots } from '../core/merkle.js';
import { sha256Hex } from '../core/crypto.js';
export const web = new Hono();
web.get('/favicon.svg', (c) => {
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0A0A0A"/><path d="M15 10h8v17l16-17h10L31 30l19 24H40L25 36l-2 2v16h-8z" fill="#E5251D"/></svg>`, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
});
function fmtDate(d) {
    if (!d)
        return '—';
    return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function fmtDur(s) {
    if (s === null || s === undefined)
        return '—';
    if (s < 3600)
        return `${Math.round(s / 60)}m`;
    if (s < 86400)
        return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
}
function corpusFeed(rows) {
    if (!rows.length)
        return '<div class="block meta">No public incidents yet.</div>';
    return rows.map((p) => `<article class="block">
<div class="meta"><b>${esc(p.failure_type)}</b> · ${esc(p.domain)} · ${esc(p.weight)}</div>
<p><span class="red"><b>Root cause.</b></span> ${esc(p.root_cause)}</p>
<p class="meta"><b>Safeguard:</b> ${esc(p.for_future_agents)}</p>
</article>`).join('');
}
function commitmentTable(rows) {
    if (!rows.length)
        return '<div class="block meta">No public commitments found.</div>';
    return `<div class="table-wrap"><table class="commitment-table">
<tr><th>Ref</th><th>Task</th><th>Type</th><th>State</th><th>Deadline</th><th>Evidence</th></tr>
${rows.map((o) => {
        if (o.visibility === 'hash_only')
            return `<tr><td><a href="/oaths/${o.ref}">${String(o.ref).padStart(4, '0')}</a></td><td colspan="2">Private task</td><td>${verdictBadge(o.status)}</td><td>—</td><td><span class="proof-label">Hash only</span></td></tr>`;
        return `<tr>
<td><a href="/oaths/${o.ref}">${String(o.ref).padStart(4, '0')}</a></td>
<td><b>${esc(o.task_title ?? 'Private task')}</b><div class="meta">${esc(o.domain ?? '')}</div></td>
<td>${esc(o.task_type ?? '—')}<div class="meta">${esc(o.risk_level ?? '')} risk</div></td>
<td>${verdictBadge(o.status)}</td>
<td class="meta">${fmtDate(o.deadline)}</td>
<td>${Number(o.verified_proofs) > 0 ? `<b>${esc(o.verified_proofs)}</b> <span class="proof-label">verified</span>` : '<span class="meta">Not supplied</span>'}</td>
</tr>`;
    }).join('')}
</table></div>`;
}
web.get('/', async (c) => {
    const corpus = await searchPostmortems({ limit: 3 });
    const recent = await queryRegistry({ limit: 6 });
    const body = `<section class="hero">
  <div class="hero-copy">
    <div class="eyebrow">Accountability for agent work</div>
    <h1>Agree on done.<br>Prove what happened.</h1>
    <p class="lede">The user owns the goal. The agent owns execution. Horkos freezes the terms, records the evidence, and keeps failures useful.</p>
    <div class="actions"><a class="primary" href="/dashboard">Register an agent</a><a href="/postmortems">Search failures</a></div>
  </div>
  <div class="hero-side">
    <div class="step"><b>01 · Commit</b>Goal, milestones, deadline, budget and evidence are locked before work.</div>
    <div class="step"><b>02 · Execute</b>The agent works against the approved contract.</div>
    <div class="step"><b>03 · Resolve</b>The owner confirms or disputes. External proof remains a separate record.</div>
  </div>
</section>
<h2>Known failures and safeguards</h2>${corpusFeed(corpus)}
<div class="actions"><a href="/postmortems">Search all failures</a></div>
<h2>Recent commitments</h2>${commitmentTable(recent)}`;
    return c.html(layout('Agent work, on the record', body));
});
web.get('/oaths', async (c) => {
    const q = c.req.query('q') ?? '';
    const status = c.req.query('status') ?? '';
    const taskType = c.req.query('task_type') ?? '';
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const pageSize = 20;
    const rows = await queryRegistry({ query: q || undefined, status: status || undefined, taskType: taskType || undefined, limit: pageSize, offset: (page - 1) * pageSize });
    if (!rows.length && page > 1)
        return c.redirect('/oaths');
    const total = Number(rows[0]?.total_count ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const params = new URLSearchParams();
    if (q)
        params.set('q', q);
    if (status)
        params.set('status', status);
    if (taskType)
        params.set('task_type', taskType);
    const pageHref = (n) => { const p = new URLSearchParams(params); p.set('page', String(n)); return `/oaths?${p}`; };
    const statuses = ['', 'OPEN', 'CLAIMED', 'KEPT', 'BROKEN', 'BROKEN_UNCONFIRMED', 'DISPUTED'];
    const types = ['', 'coding', 'research', 'data', 'content', 'operations', 'communication', 'design', 'other'];
    const body = `<h1>Commitments</h1>
<form class="filters" method="get">
  <input name="q" value="${esc(q)}" placeholder="Search task title or domain">
  <select name="status">${statuses.map((v) => `<option value="${v}"${v === status ? ' selected' : ''}>${v || 'All states'}</option>`).join('')}</select>
  <select name="task_type">${types.map((v) => `<option value="${v}"${v === taskType ? ' selected' : ''}>${v || 'All task types'}</option>`).join('')}</select>
  <button class="act">Search</button>
</form>
<div class="meta" style="margin-bottom:10px">${total} result${total === 1 ? '' : 's'} · page ${Math.min(page, pages)} of ${pages}</div>
${commitmentTable(rows)}
<div class="pager"><span>${page > 1 ? `<a href="${esc(pageHref(page - 1))}">Previous</a>` : ''}</span><span class="meta">20 per page</span><span>${page < pages ? `<a href="${esc(pageHref(page + 1))}">Next</a>` : ''}</span></div>`;
    return c.html(layout('Commitments', body));
});
web.get('/oaths/:ref', async (c) => {
    const o = await getOath(Number(c.req.param('ref')));
    if (!o)
        return c.html(layout('Not found', '<h1>Commitment not found</h1>'), 404);
    const comments = o.visibility === 'public'
        ? await pool.query(`SELECT tc.body, tc.created_at, tc.author_auth_user_id FROM task_comments tc
         JOIN oaths o ON tc.oath_id = o.id
         WHERE o.ref = $1 AND tc.withdrawn_at IS NULL
         ORDER BY tc.created_at ASC LIMIT 200`, [o.ref])
        : { rows: [] };
    const body = `<h1>Commitment ${String(o.ref).padStart(4, '0')} ${verdictBadge(o.status)}</h1>
<div class="block">${o.task_title ? `<h2 style="margin-top:0">${esc(o.task_title)}</h2>` : ''}${o.goal ? `<pre>${esc(o.goal)}</pre><div class="rule"></div>` : ''}
<div class="meta">Task: ${esc(o.domain ?? 'Private')} · Agent: ${o.agent ? `<a href="/agents/${esc(o.agent.pubkey)}">${esc(o.agent.name)}</a>` : 'Private'} · Visibility: ${esc(o.visibility)}<br>
Approved: ${fmtDate(o.activated_at)} · Deadline: ${fmtDate(o.deadline)} · Resolved: ${fmtDate(o.resolved_at)}<br>
Contract hash: <code>${esc(o.commitment_hash)}</code><br>${axes(o.axes)} · Verified cost: ${o.actuals.cost_usd !== null ? '$' + esc(o.actuals.cost_usd) : 'Not supplied'} · Duration: ${fmtDur(o.actuals.duration_s)}
${o.counterparty_withdrawn ? '<br><b>Public details withdrawn by the owner.</b>' : ''}</div></div>
<h2>Milestones</h2><div class="table-wrap"><table>
<tr><th>#</th><th>State</th><th>Title</th><th>Criterion</th><th>Deadline</th><th>Evidence</th></tr>
${o.milestones.map((m) => `<tr><td>${m.position}</td><td>${verdictBadge(m.status)}</td><td>${esc(m.title ?? 'Private')}</td><td>${esc(m.criteria_type)}</td><td class="meta">${fmtDate(m.deadline)}</td><td>${Number(m.attempts) > 0 ? `${m.attempts} verified attempt${Number(m.attempts) === 1 ? '' : 's'}` : '<span class="meta">Not supplied</span>'}</td></tr>`).join('')}
</table></div>
${o.amendments.length ? `<h2>Approved changes</h2><div class="table-wrap"><table><tr><th>Field</th><th>From</th><th>To</th><th>Approved</th></tr>${o.amendments.map((a) => `<tr><td>${esc(a.field)}</td><td>${esc(JSON.stringify(a.old_value))}</td><td>${esc(JSON.stringify(a.new_value))}</td><td>${fmtDate(a.approved_at)}</td></tr>`).join('')}</table></div>` : ''}
${o.visibility === 'public' ? `<section id="comments"><h2>Discussion</h2>
${comments.rows.map((comment) => `<div class="block"><div class="meta">Member ${esc(sha256Hex(comment.author_auth_user_id).slice(0, 8))} · ${fmtDate(comment.created_at)}</div><p>${esc(comment.body)}</p></div>`).join('') || '<div class="block meta">No comments yet.</div>'}
<form class="block" method="post" action="/oaths/${o.ref}/comments"><textarea name="body" minlength="3" maxlength="1000" required placeholder="Add a useful comment"></textarea><button class="act">Comment</button><span class="meta"> Sign-in required. Comments are public.</span></form></section>` : ''}`;
    return c.html(layout(`Commitment ${o.ref}`, body));
});
web.get('/agents/:pubkey', async (c) => {
    const a = await lookupAgent(c.req.param('pubkey'));
    if (!a)
        return c.html(layout('Not found', '<h1>Unknown agent</h1>'), 404);
    return c.html(layout(esc(a.name), `<h1>${esc(a.name)} ${a.locked ? '<span class="badge BROKEN">Blocked · RCA required</span>' : ''}</h1><div class="block meta">Agent ID: <code>${esc(a.pubkey)}</code><br>Created: ${fmtDate(a.registered_at)}<br>Only verified outcomes are included in public performance data.</div>${commitmentTable(a.oaths)}`));
});
web.get('/postmortems', async (c) => {
    const q = c.req.query('q') ?? '';
    const rows = await searchPostmortems({ query: q || undefined, limit: 20 });
    const body = `<h1>Incidents and safeguards</h1><div class="block meta">Public incidents, root causes, and prevention measures.</div>
<form class="filters" method="get"><input name="q" value="${esc(q)}" placeholder="Search incidents"><button class="act">Search</button></form>${corpusFeed(rows)}`;
    return c.html(layout('Failures', body));
});
web.get('/stats', async (c) => {
    const rows = await queryStats({ granularity: 'day', limit: 30 });
    const models = await listModels();
    const causes = await pool.query(`SELECT failure_type, count(*)::int AS n FROM postmortems p WHERE NOT EXISTS (SELECT 1 FROM oaths o WHERE o.id=p.oath_id AND o.visibility='private') GROUP BY failure_type ORDER BY n DESC, failure_type LIMIT 6`);
    const sum = (key) => rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);
    const resolved = sum('oaths_resolved');
    const completed = sum('kept');
    const failed = sum('broken') + sum('broken_unconfirmed') + sum('disputed');
    const decided = completed + failed;
    const completion = decided ? `${Math.round(completed / decided * 100)}%` : '—';
    const maxDaily = Math.max(1, ...rows.map((r) => Number(r.kept) + Number(r.broken) + Number(r.broken_unconfirmed) + Number(r.disputed)));
    const trend = rows.slice(0, 14).reverse().map((r) => {
        const good = Number(r.kept);
        const bad = Number(r.broken) + Number(r.broken_unconfirmed) + Number(r.disputed);
        const total = good + bad;
        return `<div class="trend-row"><span class="meta">${new Date(r.bucket_start).toISOString().slice(0, 10)}</span><div class="bar-track"><span class="bar-ok" style="width:${good / maxDaily * 100}%"></span><span class="bar-bad" style="width:${bad / maxDaily * 100}%"></span></div><b>${total}</b></div>`;
    }).join('') || '<div class="meta">No authenticated outcomes for this period.</div>';
    const body = `<h1>Outcome dashboard</h1>
<div class="metrics">
  <div class="metric"><span class="value">${resolved}</span>Resolved<span class="source">Source: server lifecycle events</span></div>
  <div class="metric"><span class="value">${completion}</span>Owner-confirmed completion<span class="source">Denominator: ${decided} terminal outcomes</span></div>
  <div class="metric"><span class="value">${sum('rca_filed') + sum('incidents_filed')}</span>Failure records<span class="source">Source: public structured reports</span></div>
  <div class="metric"><span class="value">${models.length || '—'}</span>Verified models<span class="source">Source: independent model-usage proofs</span></div>
</div>
<div class="dashboard-grid"><section class="block"><h2 style="margin-top:0">Outcomes · last 14 days</h2><div class="meta">Black: completed · red: failed/not confirmed/disputed · server timestamps</div>${trend}</section>
<aside><section class="block"><h2 style="margin-top:0">Common failure causes</h2>${causes.rows.map((r) => `<p><b>${esc(r.failure_type)}</b> <span class="meta">${r.n}</span></p>`).join('') || '<p class="meta">No public failures yet.</p>'}</section>
<section class="block"><h2 style="margin-top:0">Model comparison</h2>${models.length ? `<p>${models.map((m) => `<a href="/models/${encodeURIComponent(m)}">${esc(m)}</a>`).join('<br>')}</p>` : '<p class="meta">Unavailable. No independently verified model-usage proofs have been received.</p>'}</section></aside></div>`;
    return c.html(layout('Stats', body));
});
web.get('/models/:model', async (c) => {
    const model = c.req.param('model');
    const rows = await queryStats({ model, granularity: 'day', limit: 90 });
    return c.html(layout(esc(model), `<h1>${esc(model)} <span class="proof-label">verified usage</span></h1><div class="block meta">Outcomes for commitments with independently verified model usage.</div>${rows.length ? `<div class="block">${rows.length} daily evidence buckets available.</div>` : '<div class="block meta">No verified data for this period.</div>'}`));
});
web.get('/log', async (c) => {
    const roots = await listMerkleRoots();
    const count = await pool.query(`SELECT count(*)::int AS n FROM entry_log`);
    const body = `<h1>Integrity log</h1><div class="block">${count.rows[0].n} application events are hash-chained. Signed roots make later changes detectable. <a href="/log.json">Download</a>.</div><div class="table-wrap"><table><tr><th>Range</th><th>Root</th><th>Signed</th></tr>${roots.map((r) => `<tr><td>${r.from_seq}–${r.to_seq}</td><td><code>${esc(r.root)}</code></td><td>${fmtDate(r.signed_at)}</td></tr>`).join('') || '<tr><td colspan="3" class="meta">No signed roots yet.</td></tr>'}</table></div>`;
    return c.html(layout('Integrity log', body));
});
web.get('/log.json', async (c) => c.json(await listMerkleRoots(10000)));
web.all('/approve/:token', (c) => c.text('This link is no longer valid. Sign in to the Dashboard.', 410));
web.all('/respond/:token', (c) => c.text('This link is no longer valid. Sign in to the Dashboard.', 410));
web.all('/respond/:token/:claimId', (c) => c.text('This link is no longer valid. Sign in to the Dashboard.', 410));
//# sourceMappingURL=routes.js.map