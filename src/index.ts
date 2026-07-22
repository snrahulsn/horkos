import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { web } from './web/routes.js';
import { buildMcpServer } from './mcp/server.js';
import { registerAgent, agentFromToken } from './core/registry.js';
import { startScheduler } from './scheduler/index.js';
import { GuardrailError } from './core/commitments.js';

const app = new Hono();

// ---------- health ----------
app.get('/health', (c) => c.json({ ok: true, service: 'horkos', version: '1.0.0' }));

// ---------- registration (REST; operator OAuth in front) ----------
// v1: Supabase Auth JWT arrives as Bearer; we trust its `sub` as auth_user_id.
// Deployments without Supabase configured can register with X-Operator-Id (dev only).
app.post('/api/register_agent', async (c) => {
  try {
    let authUserId: string | null = null;
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ') && process.env.SUPABASE_JWT_SECRET) {
      const { createHmac } = await import('node:crypto');
      const [h, p, sig] = auth.slice(7).split('.');
      if (!h || !p || !sig) return c.json({ error: 'malformed JWT' }, 401);
      const expected = createHmac('sha256', process.env.SUPABASE_JWT_SECRET)
        .update(`${h}.${p}`)
        .digest('base64url');
      if (expected !== sig) return c.json({ error: 'invalid JWT signature' }, 401);
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      if (payload.exp && payload.exp * 1000 < Date.now()) return c.json({ error: 'JWT expired' }, 401);
      authUserId = payload.sub;
    } else if (process.env.NODE_ENV !== 'production') {
      authUserId = c.req.header('x-operator-id') ?? null;
    }
    if (!authUserId) return c.json({ error: 'operator authentication required' }, 401);

    const body = await c.req.json();
    if (!body?.agent_name || typeof body.agent_name !== 'string') {
      return c.json({ error: 'agent_name required' }, 400);
    }
    const result = await registerAgent(authUserId, body.agent_name, body.display_name);
    return c.json({
      ...result,
      note: 'api_token is shown once. It authenticates MCP write tools. The signing key is custodial and never leaves the server.',
    });
  } catch (e) {
    if (e instanceof GuardrailError) return c.json({ error: e.errors }, 400);
    console.error(e);
    return c.json({ error: 'internal error' }, 500);
  }
});

// ---------- MCP (stateless streamable HTTP) ----------
app.all('/mcp', async (c) => {
  // resolve agent identity from bearer token (write tools need it; read tools don't)
  let agentId: string | null = null;
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    const agent = await agentFromToken(auth.slice(7));
    if (agent) agentId = agent.id;
  }

  const server = buildMcpServer(() => agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const { incoming, outgoing } = c.env as any;
  const body = c.req.method === 'POST' ? await c.req.json().catch(() => undefined) : undefined;
  await transport.handleRequest(incoming, outgoing, body);
  // response written directly to the node socket
  return new Response(null);
});

// ---------- web ----------
app.route('/', web);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`HORKOS listening on :${info.port}`);
  startScheduler();
});
