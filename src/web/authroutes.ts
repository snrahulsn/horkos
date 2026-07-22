import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { layout, esc, verdictBadge } from './html.js';
import {
  supabaseConfig, authConfigured, verifyAccessToken, makeSession,
  readSession, sessionCookie, clearCookie, readCookie,
} from './auth.js';
import { registerAgent } from '../core/registry.js';
import { activateOathAsOperator, rejectDraftAsOperator, GuardrailError } from '../core/commitments.js';
import { respondToClaimAsOperator } from '../core/claims.js';

export const auth = new Hono();

function requireUser(c: any) {
  return readSession(readCookie(c.req.header('cookie')));
}

function sameOrigin(c: any): boolean {
  const origin = c.req.header('origin');
  if (!origin) return process.env.NODE_ENV !== 'production';
  return origin === new URL(c.req.url).origin;
}

// ---- login: email -> OTP/magic-link via Supabase, done client-side ----

auth.get('/login', (c) => {
  if (!authConfigured()) {
    return c.html(
      layout('Sign in', `<h1>Sign-in unavailable</h1><div class="block">Sign-in is temporarily unavailable.</div>`),
      503,
    );
  }
  const { url, anonKey } = supabaseConfig();
  const callbackUrl = `${process.env.BASE_URL ?? new URL(c.req.url).origin}/auth/callback`;
  const oauthUrl = (provider: 'github' | 'google') =>
    `${url}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(callbackUrl)}`;
  const socialProviders = [
    process.env.AUTH_GITHUB_ENABLED === 'true' ? { id: 'github' as const, label: 'GitHub' } : null,
    process.env.AUTH_GOOGLE_ENABLED === 'true' ? { id: 'google' as const, label: 'Google' } : null,
  ].filter((provider): provider is { id: 'github' | 'google'; label: string } => provider !== null);
  const socialButtons = socialProviders.length
    ? `<div class="actions" style="margin-top:0">${socialProviders.map((provider, index) =>
        `<a${index === 0 ? ' class="primary"' : ''} href="${esc(oauthUrl(provider.id))}">Continue with ${provider.label}</a>`,
      ).join('')}</div><div class="rule"></div>`
    : '';
  const body = `
<h1>Start with Horkos</h1>
<div class="block">Sign in to connect agents, approve commitments, and review outcomes.</div>
<div class="block">
  ${socialButtons}
  <div id="step-email">
    <input id="email" type="email" placeholder="you@example.com"
      style="font-family:inherit;padding:10px;border:3px solid var(--fg);background:var(--bg);color:var(--fg);width:60%">
    <button class="act" onclick="sendLink()">Email me a sign-in link</button>
  </div>
  <div id="msg" class="meta" style="margin-top:16px"></div>
</div>
<script>
  const SB_URL = ${JSON.stringify(url)};
  const SB_KEY = ${JSON.stringify(anonKey)};
  async function sendLink() {
    const email = document.getElementById('email').value.trim();
    const msg = document.getElementById('msg');
    if (!email) { msg.textContent = 'Enter your email.'; return; }
    msg.textContent = 'Sending…';
    try {
      const res = await fetch(SB_URL + '/auth/v1/otp', {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true,
          options: { email_redirect_to: location.origin + '/auth/callback' } })
      });
      if (res.ok) { msg.textContent = 'Check your email to continue.'; }
      else { msg.textContent = 'Couldn’t send the link. Please try again.'; }
    } catch (e) { msg.textContent = 'Couldn’t send the link. Please try again.'; }
  }
</script>`;
  return c.html(layout('Login', body));
});

// ---- callback: Supabase returns tokens in the URL hash; exchange for a session cookie ----

auth.get('/auth/callback', (c) => {
  const body = `
<h1>Signing in…</h1>
<div class="block meta" id="msg">Completing login…</div>
<script>
  (async function(){
    const msg = document.getElementById('msg');
    // magic-link puts tokens in the fragment: #access_token=...&refresh_token=...
    const h = new URLSearchParams(location.hash.slice(1));
    let token = h.get('access_token');
    // OTP-verify links may instead arrive as ?token_hash=...&type=...
    if (!token) {
      const q = new URLSearchParams(location.search);
      const th = q.get('token_hash'); const type = q.get('type');
      if (th && type) {
        const r = await fetch(${JSON.stringify(supabaseConfig().url)} + '/auth/v1/verify', {
          method:'POST', headers:{'apikey':${JSON.stringify(supabaseConfig().anonKey)},'Content-Type':'application/json'},
          body: JSON.stringify({ token_hash: th, type })
        });
        if (r.ok) { const d = await r.json(); token = d.access_token; }
      }
    }
    if (!token) {
      const oauthError = h.get('error_description') || h.get('error');
      msg.textContent = oauthError ? 'Sign-in was not completed. Please try again.' : 'This sign-in link is invalid or expired. Request a new one.';
      return;
    }
    const res = await fetch('/auth/session', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ access_token: token })
    });
    if (res.ok) { location.href = '/dashboard'; }
    else { msg.textContent = 'Couldn’t sign you in. Please try again.'; }
  })();
</script>`;
  return c.html(layout('Signing in', body));
});

auth.post('/auth/session', async (c) => {
  const { access_token } = await c.req.json().catch(() => ({ access_token: '' }));
  if (!access_token) return c.json({ error: 'no token' }, 400);
  const user = await verifyAccessToken(access_token);
  if (!user) return c.json({ error: 'invalid token' }, 401);
  c.header('Set-Cookie', sessionCookie(makeSession(user)));
  return c.json({ ok: true });
});

auth.get('/logout', (c) => {
  c.header('Set-Cookie', clearCookie());
  return c.redirect('/');
});

// ---- dashboard: register agents, see tokens, list oaths ----

auth.get('/dashboard', async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect('/login');

  const agents = await pool.query(
    `SELECT a.pubkey, a.name, a.locked, a.created_at,
            (SELECT count(*) FROM oaths o WHERE o.agent_id = a.id AND o.status NOT IN ('DRAFT','DRAFT_EXPIRED')) AS oaths
     FROM agents a JOIN operators op ON a.operator_id = op.id
     WHERE op.auth_user_id = $1 ORDER BY a.created_at`,
    [user.id],
  );

  const pendingDrafts = await pool.query(
    `SELECT o.id, o.ref, o.task_title, o.goal, o.domain, o.task_type, o.complexity, o.risk_level,
            o.deliverable_type, o.required_tools, o.deadline, o.budget_cap_usd,
            o.model_declared, o.visibility, o.commitment_hash,
            coalesce(json_agg(json_build_object(
              'position', m.position, 'title', m.title, 'criteria', m.criteria_detail,
              'deadline', m.deadline, 'budget', m.budget_slice_usd
            ) ORDER BY m.position) FILTER (WHERE m.id IS NOT NULL), '[]') AS milestones
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     JOIN operators op ON a.operator_id = op.id
     LEFT JOIN milestones m ON m.oath_id = o.id
     WHERE op.auth_user_id = $1 AND o.status = 'DRAFT' AND o.draft_expires_at > now()
     GROUP BY o.id ORDER BY o.created_at DESC`,
    [user.id],
  );

  const pendingClaims = await pool.query(
    `SELECT c.id, o.ref, m.position, m.title, m.criteria_detail, c.evidence,
            c.actual_cost_usd, c.actual_duration_s, c.filed_at
     FROM claims c JOIN milestones m ON c.milestone_id = m.id
     JOIN oaths o ON m.oath_id = o.id JOIN agents a ON o.agent_id = a.id
     JOIN operators op ON a.operator_id = op.id
     WHERE op.auth_user_id = $1 AND c.counterparty_response IS NULL
     ORDER BY c.filed_at`,
    [user.id],
  );

  const justToken = c.req.query('token');
  const justName = c.req.query('name');

  const body = `
<h1>Workspace</h1>
<div class="block meta">Signed in as ${esc(user.email ?? user.id)} · <a href="/logout">log out</a></div>
${
  justToken
    ? `<div class="block"><b>Agent "${esc(justName)}" is ready.</b> Copy this token now—it will not be shown again.<br><br>
       <code style="word-break:break-all">${esc(justToken)}</code><br><br>
       <span class="meta">Use as an HTTP <code>Authorization: Bearer &lt;token&gt;</code> header against <code>/mcp</code>. Only a hash of this token is stored.</span></div>`
    : ''
}
<h2>Commitments awaiting your approval</h2>
${pendingDrafts.rows.length ? pendingDrafts.rows.map((o: any) => `<div class="block">
<b>Commitment ${String(o.ref).padStart(4, '0')} · ${esc(o.task_title)}</b><br>
<div class="meta">${esc(o.task_type)} · ${esc(o.complexity)} · risk ${esc(o.risk_level)} · ${esc(o.deliverable_type)} · tools: ${esc(o.required_tools.join(', ') || 'none')}</div>
<pre>${esc(o.goal)}</pre>
<div class="meta">deadline: ${esc(new Date(o.deadline).toISOString())} · budget: $${esc(o.budget_cap_usd)} · visibility: ${esc(o.visibility)}<br>
Contract hash: <code>${esc(o.commitment_hash)}</code></div>
<ol>${o.milestones.map((m: any) => `<li><b>${esc(m.title)}</b> — ${esc(JSON.stringify(m.criteria))} · ${esc(new Date(m.deadline).toISOString())} · $${esc(m.budget)}</li>`).join('')}</ol>
<form method="post" action="/dashboard/oaths/${esc(o.id)}/approve">
  <button class="act">Approve and lock terms</button>
  <button class="act danger" name="decision" value="reject">Reject</button>
</form>
</div>`).join('') : '<div class="block meta">No drafts awaiting approval.</div>'}
<h2>Outcomes awaiting your review</h2>
${pendingClaims.rows.length ? pendingClaims.rows.map((r: any) => `<div class="block">
<b>Commitment ${String(r.ref).padStart(4, '0')} · milestone ${r.position}</b> · ${esc(r.title ?? '')}<br>
<div class="meta">criteria: ${esc(JSON.stringify(r.criteria_detail))}<br>evidence: ${esc(JSON.stringify(r.evidence))}<br>
reported cost (not verified): $${esc(r.actual_cost_usd)} · duration: ${esc(r.actual_duration_s)}s</div>
<form method="post" action="/dashboard/claims/${esc(r.id)}/respond">
  <button class="act" name="response" value="confirm">Confirm completion</button>
  <button class="act danger" name="response" value="dispute">Dispute completion</button>
  <textarea name="statement" placeholder="Why do you dispute this claim?"></textarea>
</form></div>`).join('') : '<div class="block meta">No outcomes awaiting your review.</div>'}
<h2>Your agents</h2>
${
  agents.rows.length
    ? `<div class="table-wrap"><table><tr><th>Name</th><th>Agent ID</th><th>Status</th><th>Commitments</th></tr>${agents.rows
        .map(
          (a: any) => `<tr>
<td><a href="/agents/${esc(a.pubkey)}">${esc(a.name)}</a></td>
<td class="meta"><code>${esc(a.pubkey.slice(0, 16))}…</code></td>
<td>${a.locked ? '<span class="badge BROKEN">LOCKED</span>' : 'active'}</td>
<td>${a.oaths}</td></tr>`,
        )
        .join('')}</table></div>`
    : '<div class="block meta">No agents yet. Connect one below.</div>'
}
<h2>Connect an agent</h2>
<div class="block">
<form method="post" action="/dashboard/register">
  <input name="agent_name" placeholder="Agent name"
    style="font-family:inherit;padding:10px;border:3px solid var(--fg);background:var(--bg);color:var(--fg);width:50%">
  <button class="act">Create API token</button>
</form>
<span class="meta">Each agent uses its token for authenticated Horkos actions.</span>
</div>
<h2>Connect</h2>
<div class="block meta">Add the Horkos MCP server to your agent and authenticate it with this token. The agent can then propose commitments for your approval.</div>`;
  return c.html(layout('Dashboard', body));
});

auth.post('/dashboard/oaths/:id/approve', async (c) => {
  if (!sameOrigin(c)) return c.text('Request could not be verified.', 403);
  const user = requireUser(c);
  if (!user) return c.redirect('/login');
  try {
    const form = await c.req.parseBody();
    if (form['decision'] === 'reject') await rejectDraftAsOperator(c.req.param('id'), user.id);
    else await activateOathAsOperator(c.req.param('id'), user.id);
    return c.redirect('/dashboard');
  } catch (e) {
    const msg = e instanceof GuardrailError ? e.errors.join('; ') : 'error';
    return c.html(layout('Action not completed', `<h1 class="red">Action not completed</h1><div class="block">${esc(msg)}</div>`), 400);
  }
});

auth.post('/dashboard/claims/:id/respond', async (c) => {
  if (!sameOrigin(c)) return c.text('Request could not be verified.', 403);
  const user = requireUser(c);
  if (!user) return c.redirect('/login');
  const form = await c.req.parseBody();
  try {
    await respondToClaimAsOperator(
      user.id,
      c.req.param('id'),
      form['response'] === 'dispute' ? 'dispute' : 'confirm',
      typeof form['statement'] === 'string' ? form['statement'] : undefined,
    );
    return c.redirect('/dashboard');
  } catch (e) {
    const msg = e instanceof GuardrailError ? e.errors.join('; ') : 'error';
    return c.html(layout('Action not completed', `<h1 class="red">Action not completed</h1><div class="block">${esc(msg)}</div>`), 400);
  }
});

auth.post('/dashboard/register', async (c) => {
  if (!sameOrigin(c)) return c.text('Request could not be verified.', 403);
  const user = requireUser(c);
  if (!user) return c.redirect('/login');
  const form = await c.req.parseBody();
  const name = typeof form['agent_name'] === 'string' ? form['agent_name'].trim() : '';
  if (!name) return c.redirect('/dashboard');
  try {
    const r = await registerAgent(user.id, name, user.email ?? undefined);
    return c.redirect(`/dashboard?token=${encodeURIComponent(r.api_token)}&name=${encodeURIComponent(name)}`);
  } catch (e) {
    const msg = e instanceof GuardrailError ? e.errors.join('; ') : 'error';
    return c.html(layout('Action not completed', `<h1 class="red">Action not completed</h1><div class="block">${esc(msg)}</div><div class="block"><a href="/dashboard">back</a></div>`), 400);
  }
});

auth.post('/oaths/:ref/comments', async (c) => {
  if (!sameOrigin(c)) return c.text('Request could not be verified.', 403);
  const user = requireUser(c);
  if (!user) return c.redirect('/login');
  const ref = Number(c.req.param('ref'));
  const form = await c.req.parseBody();
  const body = typeof form['body'] === 'string' ? form['body'].trim() : '';
  if (!Number.isInteger(ref) || body.length < 3 || body.length > 1000) {
    return c.html(layout('Comment not added', '<h1>Comment not added</h1><div class="block">Comments must contain 3–1000 characters.</div>'), 400);
  }

  const recent = await pool.query(
    `SELECT count(*)::int AS n FROM task_comments
     WHERE author_auth_user_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (Number(recent.rows[0].n) >= 5) {
    return c.html(layout('Comment not added', '<h1>Comment not added</h1><div class="block">Comment limit reached. Try again later.</div>'), 429);
  }

  const inserted = await pool.query(
    `INSERT INTO task_comments (oath_id, author_auth_user_id, body)
     SELECT id, $2, $3 FROM oaths
     WHERE ref = $1 AND visibility = 'public'
       AND status NOT IN ('DRAFT','DRAFT_EXPIRED')
     RETURNING id`,
    [ref, user.id, body],
  );
  if (!inserted.rows.length) {
    return c.html(layout('Comment not added', '<h1>Comment not added</h1><div class="block">This task is not open for public comments.</div>'), 404);
  }
  return c.redirect(`/oaths/${ref}#comments`);
});
