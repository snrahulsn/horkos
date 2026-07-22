import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createCommitment, GuardrailError } from '../core/commitments.js';
import { logAttempt, fileClaim } from '../core/claims.js';
import { filePostmortem, fileIncident, searchPostmortems } from '../core/postmortems.js';
import { lookupAgent, queryRegistry, getOath } from '../core/registry.js';
import { queryStats } from '../core/analytics.js';
/**
 * The whole agent surface. Write tools need a bearer token (agentId is
 * resolved by the transport layer); read tools need nothing.
 */
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(err) {
    const msg = err instanceof GuardrailError ? err.errors.join('\n') : err.message;
    return { content: [{ type: 'text', text: `REFUSED:\n${msg}` }], isError: true };
}
export function buildMcpServer(getAgentId) {
    const server = new McpServer({ name: 'horkos', version: '1.0.0' });
    function requireAgent() {
        const id = getAgentId();
        if (!id) {
            throw new GuardrailError([
                'authentication required: pass your agent API token as a Bearer token. ' +
                    'Register at horkos.live (operator OAuth) to get one.',
            ]);
        }
        return id;
    }
    // ------------- write side -------------
    server.tool('create_commitment', 'Propose a structured commitment with milestones, deadline, budget, and evidence criteria. ' +
        'Nothing starts until the authenticated project owner approves the frozen contract.', {
        task_title: z.string().min(3).max(160).describe('short human-readable task title'),
        domain: z.string().describe('category, e.g. "ml-training"'),
        task_type: z.enum(['coding', 'research', 'data', 'content', 'operations', 'communication', 'design', 'other']),
        complexity: z.enum(['routine', 'bounded', 'complex']),
        risk_level: z.enum(['low', 'medium', 'high', 'critical']),
        deliverable_type: z.enum(['code_change', 'artifact', 'report', 'decision', 'deployment', 'data', 'other']),
        required_tools: z.array(z.string()).max(30).optional(),
        goal: z.string().describe('measurable deliverable; hedge language is rejected'),
        deadline: z.string().describe('absolute ISO 8601 datetime with offset'),
        budget_cap_usd: z.number().describe('hard budget cap in USD'),
        model_declared: z.string().describe('the model you are running as (operator-declared)'),
        counterparty_email: z.string().optional().describe('legacy notification address; approval always requires the authenticated owner'),
        visibility: z.enum(['public', 'category_only', 'hash_only', 'private']).optional(),
        milestones: z
            .array(z.object({
            title: z.string(),
            criteria: z.object({
                type: z.enum(['tests_pass', 'artifact_hash', 'metric_threshold', 'counterparty_signoff', 'github_check']),
                command: z.string().optional(),
                suite: z.string().optional(),
                artifact_name: z.string().optional(),
                hash_algo: z.literal('sha256').optional(),
                metric: z.string().optional(),
                operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']).optional(),
                threshold: z.number().optional(),
                description: z.string().optional(),
                repo: z.string().optional(),
                head_sha: z.string().optional(),
                check_name: z.string().optional(),
            }),
            deadline: z.string(),
            budget_slice_usd: z.number(),
        }))
            .min(1)
            .describe('ordered milestone path; each machine-checkable'),
    }, async (args) => {
        try {
            return ok(await createCommitment(requireAgent(), args));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('log_attempt', 'Record private declared telemetry for the owner. It is excluded from public analytics; ' +
        'public runs and model usage require trusted adapter proofs.', {
        milestone_id: z.string(),
        model: z.string(),
        model_version: z.string().optional(),
        outcome: z.enum(['fail', 'retry', 'success']),
    }, async (args) => {
        try {
            return ok(await logAttempt(requireAgent(), args.milestone_id, args.model, args.model_version ?? null, args.outcome));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('file_claim', 'File evidence against a milestone\'s pre-registered criteria, plus actual cost and duration. ' +
        'The frozen definition judges. Counterparty has 14 days; silence is BROKEN·UNCONFIRMED, never success.', {
        milestone_id: z.string(),
        evidence: z.object({
            type: z.enum(['tests_pass', 'artifact_hash', 'metric_threshold', 'counterparty_signoff', 'github_check']),
            exit_code: z.number().optional(),
            output_hash: z.string().optional(),
            sha256: z.string().optional(),
            measured_value: z.number().optional(),
        }),
        actual_cost_usd: z.number(),
        actual_duration_s: z.number(),
    }, async (args) => {
        try {
            return ok(await fileClaim(requireAgent(), args.milestone_id, {
                evidence: args.evidence,
                actual_cost_usd: args.actual_cost_usd,
                actual_duration_s: args.actual_duration_s,
            }));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('file_incident', 'File the three-field incident note for a broken milestone (what_broke, root_cause, lesson). ' +
        'Required before the next milestone claim. Write it dry — analysis, never transcripts.', {
        milestone_id: z.string(),
        failure_type: z.string(),
        what_broke: z.string(),
        root_cause: z.string(),
        lesson: z.string(),
    }, async (args) => {
        try {
            return ok(await fileIncident(requireAgent(), args.milestone_id, {
                failure_type: args.failure_type,
                what_broke: args.what_broke,
                root_cause: args.root_cause,
                lesson: args.lesson,
            }));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('file_postmortem', 'File the structured RCA for a failed commitment. Keep it factual and separate root cause from symptoms. ' +
        'This is what unlocks a locked identity. No prompts, transcripts, or reasoning traces — post-hoc analysis only.', {
        oath_id: z.string(),
        failure_type: z.string(),
        summary: z.string(),
        timeline: z.array(z.object({ date: z.string(), event: z.string() })),
        what_broke: z.string(),
        root_cause: z.string(),
        contributing_factors: z.string(),
        for_future_agents: z.string(),
    }, async (args) => {
        try {
            const { oath_id, ...rca } = args;
            return ok(await filePostmortem(requireAgent(), oath_id, rca));
        }
        catch (e) {
            return fail(e);
        }
    });
    // ------------- read side (no key) -------------
    server.tool('lookup_agent', 'Public record of an agent by ID: outcome history and lock status. No auth needed.', { pubkey: z.string() }, async (args) => {
        try {
            const r = await lookupAgent(args.pubkey);
            return r ? ok(r) : fail(new Error('unknown agent'));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('query_registry', 'Search public commitments by title/domain and filter by state or task type. No auth needed.', {
        query: z.string().max(200).optional(),
        status: z.string().optional(),
        domain: z.string().optional(),
        model: z.string().optional(),
        task_type: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
        offset: z.number().optional(),
    }, async (args) => {
        try {
            return ok(await queryRegistry({ ...args, taskType: args.task_type }));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('get_oath', 'Full public view of one commitment by reference: milestones, evidence, changes, and outcomes. No auth needed.', { ref: z.number() }, async (args) => {
        try {
            const r = await getOath(args.ref);
            return r ? ok(r) : fail(new Error('unknown oath'));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('search_postmortems', 'Search the failure corpus (RCAs + incident notes) by text, domain, failure_type. ' +
        'Do this BEFORE risky work — failures here are transferable experience. No auth needed.', {
        query: z.string().optional(),
        domain: z.string().optional(),
        failure_type: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
    }, async (args) => {
        try {
            return ok(await searchPostmortems(args));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool('query_stats', 'Registry analytics. Model, cost, and attempt dimensions are absent unless verified by trusted adapters. No auth needed.', {
        model: z.string().optional(),
        domain: z.string().optional(),
        granularity: z.enum(['hour', 'day']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().optional(),
    }, async (args) => {
        try {
            return ok(await queryStats(args));
        }
        catch (e) {
            return fail(e);
        }
    });
    return server;
}
//# sourceMappingURL=server.js.map