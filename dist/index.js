import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { web } from './web/routes.js';
import { auth } from './web/authroutes.js';
import { buildMcpServer } from './mcp/server.js';
import { registerAgent, agentFromToken } from './core/registry.js';
import { startScheduler } from './scheduler/index.js';
import { runMigrations } from './db/migrate.js';
import { GuardrailError } from './core/commitments.js';
import { verifyAccessToken } from './web/auth.js';
import { pool } from './db/pool.js';
import { ingestGitHubCheckRun } from './integrations/github.js';
import { verifyProofIngestorConnection } from './core/proofs.js';
const app = new Hono();
app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') {
        c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
});
// ---------- health ----------
app.get('/health', async (c) => {
    try {
        await pool.query('SELECT 1');
        return c.json({ ok: true, service: 'horkos', version: '1.0.0' });
    }
    catch {
        return c.json({ ok: false, service: 'horkos' }, 503);
    }
});
app.post('/webhooks/github', async (c) => {
    try {
        const body = await c.req.text();
        const result = await ingestGitHubCheckRun(body, c.req.header('x-hub-signature-256'), c.req.header('x-github-event'));
        return c.json(result);
    }
    catch (error) {
        const unauthorized = error.message.includes('signature');
        return c.json({ error: unauthorized ? 'unauthorized' : 'webhook rejected' }, unauthorized ? 401 : 400);
    }
});
// ---------- registration (REST; operator OAuth in front) ----------
// Supabase access tokens are verified with Supabase Auth.
// Deployments without Supabase configured can register with X-Operator-Id (dev only).
app.post('/api/register_agent', async (c) => {
    try {
        let authUserId = null;
        const auth = c.req.header('authorization');
        if (auth?.startsWith('Bearer ')) {
            const user = await verifyAccessToken(auth.slice(7));
            authUserId = user?.id ?? null;
        }
        else if (process.env.NODE_ENV !== 'production') {
            authUserId = c.req.header('x-operator-id') ?? null;
        }
        if (!authUserId)
            return c.json({ error: 'operator authentication required' }, 401);
        const body = await c.req.json();
        if (!body?.agent_name || typeof body.agent_name !== 'string') {
            return c.json({ error: 'agent_name required' }, 400);
        }
        const result = await registerAgent(authUserId, body.agent_name, body.display_name);
        return c.json({
            ...result,
            note: 'api_token is shown once. It authenticates MCP write tools; only its hash is stored.',
        });
    }
    catch (e) {
        if (e instanceof GuardrailError)
            return c.json({ error: e.errors }, 400);
        console.error(e);
        return c.json({ error: 'internal error' }, 500);
    }
});
// ---------- MCP (stateless streamable HTTP) ----------
app.all('/mcp', async (c) => {
    // resolve agent identity from bearer token (write tools need it; read tools don't)
    let agentId = null;
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
        const agent = await agentFromToken(auth.slice(7));
        if (agent)
            agentId = agent.id;
    }
    const server = buildMcpServer(() => agentId);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
});
// ---------- auth + web ----------
app.route('/', auth);
app.route('/', web);
const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV === 'production') {
    const required = [
        'BASE_URL', 'SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
        'PROOF_DATABASE_URL', 'PROOF_INGEST_SECRET', 'GITHUB_WEBHOOK_SECRET',
        'MERKLE_SIGNING_SEED',
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length)
        throw new Error(`missing required production configuration: ${missing.join(', ')}`);
    if ((process.env.SESSION_SECRET ?? '').length < 32) {
        throw new Error('SESSION_SECRET must contain at least 32 characters in production');
    }
    if ((process.env.PROOF_INGEST_SECRET ?? '').length < 32 || (process.env.GITHUB_WEBHOOK_SECRET ?? '').length < 32) {
        throw new Error('proof and webhook secrets must contain at least 32 characters in production');
    }
    if (!/^[0-9a-f]{64}$/i.test(process.env.MERKLE_SIGNING_SEED ?? '')) {
        throw new Error('MERKLE_SIGNING_SEED must be exactly 32 bytes encoded as hex');
    }
    if (!process.env.BASE_URL?.startsWith('https://')) {
        throw new Error('BASE_URL must use HTTPS in production');
    }
}
// Migrate on boot (single process, no start-command chain), then listen.
runMigrations()
    .then(async () => {
    if (process.env.NODE_ENV === 'production')
        await verifyProofIngestorConnection();
    serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
        console.log(`HORKOS listening on ${info.address}:${info.port}`);
        startScheduler();
    });
})
    .catch((err) => {
    console.error('startup failed:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map