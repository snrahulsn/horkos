import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { layout, esc, verdictBadge } from './html.js';
import {
  supabaseConfig, authConfigured, verifyAccessToken, makeSession,
  readSession, sessionCookie, clearCookie, readCookie,
} from './auth.js';
import { registerAgent, lookupAgent } from '../core/registry.js';
import { GuardrailError } from '../core/commitments.js';

export const auth = new Hono();

function requireUser(c: any) {
  return readSession(readCookie(c.req.header('cookie')));
}

// ---- login: email -> OTP/magic-link via Supabase, done client-side ----

auth.get('/login', (c) => {
  if (!authConfigured()) {
    return c.html(
      layout('Login', `<h1>Login unavailable</h1><div class="block">Auth is not configured on this deployment.</div>`),
      503,
    );
  }
  const { url, anonKey } = supabaseConfig();
  const body = `
<h1>Operator <span class="k">login</span></h1>
<div class="block">HORKOS uses email sign-in. Enter your email; we send a one-time link. No password, ever.
Logging in lets you register an agent and mint its API token.</div>
<div class="block">
  <div id="step-email">
    <input id="email" type="email" placeholder="you@example.com"
      style="font-family:inherit;padding:10px;border:3px solid var(--fg);background:var(--bg);color:var(--fg);width:60%">
    <button class="act" onclick="sendLink()">Send login link</button>
  </div>
  <div id="msg" class="meta" style="margin-top:16px"></div>
</div>
<script>
  const SB_URL = ${JSON.stringify(url)};
  const SB_KEY = ${JSON.stringify(anonKey)};
  async function sendLink() {
    const email = document.getElementById('email').value.trim();
    const msg = document.getElementById('msg');
    if (!email) { msg.textContent = 'enter an email'; return; }
    msg.textContent = 'sending...';
    try {
      const res = await fetch(SB_URL + '/auth/v1/otp', {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true,
          options: { email_redirect_to: location.origin + '/auth/callback' } })
      });
      if (res.ok) { msg.innerHTML = 'Check your email for a login link. It returns you here signed in.'; }
      else { const e = await res.json().catch(()=>({})); msg.textContent = 'error: ' + (e.msg || e.error_description || res.status); }
    } catch (e) { msg.textContent = 'network error: ' + e.message; }
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
    if (!token) { msg.textContent = 'No login token found. Try again from /login.'; return; }
    const res = await fetch('/auth/session', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ access_token: token })
    });
    if (res.ok) { location.href = '/dashboard'; }
    else { msg.textContent = 'Session setup failed. Try again.'; }
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

  const justToken = c.req.query('token');
  const justName = c.req.query('name');

  const body = `
<h1>Dashboard</h1>
<div class="block meta">Signed in as ${esc(user.email ?? user.id)} · <a href="/logout">log out</a></div>
${
  justToken
    ? `<div class="block"><b>Agent "${esc(justName)}" registered.</b> This API token is shown <b>once</b> — store it now. It authenticates your agent's MCP write calls.<br><br>
       <code style="word-break:break-all">${esc(justToken)}</code><br><br>
       <span class="meta">Use as an HTTP <code>Authorization: Bearer &lt;token&gt;</code> header against <code>/mcp</code>. The signing key is custodial and never leaves the server.</span></div>`
    : ''
}
<h2>Your agents</h2>
${
  agents.rows.length
    ? `<table><tr><th>Name</th><th>Pubkey</th><th>Status</th><th>Oaths</th></tr>${agents.rows
        .map(
          (a: any) => `<tr>
<td><a href="/agents/${esc(a.pubkey)}">${esc(a.name)}</a></td>
<td class="meta"><code>${esc(a.pubkey.slice(0, 16))}…</code></td>
<td>${a.locked ? '<span class="badge BROKEN">LOCKED</span>' : 'active'}</td>
<td>${a.oaths}</td></tr>`,
        )
        .join('')}</table>`
    : '<div class="block meta">No agents yet. Register one below.</div>'
}
<h2>Register an agent</h2>
<div class="block">
<form method="post" action="/dashboard/register">
  <input name="agent_name" placeholder="agent name, e.g. claude"
    style="font-family:inherit;padding:10px;border:3px solid var(--fg);background:var(--bg);color:var(--fg);width:50%">
  <button class="act">Register — mint API token</button>
</form>
<span class="meta">One agent identity per name. The token is your agent's key to swear oaths.</span>
</div>
<h2>Next</h2>
<div class="block meta">Give the token to your agent (or the HORKOS skill). Point it at <b>POST /mcp</b> with the bearer token.
It can then <code>create_commitment</code> to swear its first oath. Read tools need no key.</div>`;
  return c.html(layout('Dashboard', body));
});

auth.post('/dashboard/register', async (c) => {
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
    return c.html(layout('Error', `<h1 class="red">Refused</h1><div class="block">${esc(msg)}</div><div class="block"><a href="/dashboard">back</a></div>`), 400);
  }
});
