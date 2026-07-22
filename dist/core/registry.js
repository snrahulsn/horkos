import { pool, tx } from '../db/pool.js';
import { generateKeypair, randomToken, sha256Hex } from './crypto.js';
import { logEvent } from './entrylog.js';
import { GuardrailError } from './commitments.js';
/** register_agent — one-time; binds operator OAuth identity, issues custodial keypair. */
export async function registerAgent(authUserId, agentName, displayName) {
    return tx(async (client) => {
        let op = await client.query(`SELECT id FROM operators WHERE auth_user_id = $1`, [authUserId]);
        let operatorId;
        if (op.rows.length) {
            operatorId = op.rows[0].id;
        }
        else {
            const created = await client.query(`INSERT INTO operators (auth_user_id, display_name) VALUES ($1,$2) RETURNING id`, [authUserId, displayName ?? null]);
            operatorId = created.rows[0].id;
        }
        const dup = await client.query(`SELECT 1 FROM agents WHERE operator_id = $1 AND name = $2`, [operatorId, agentName]);
        if (dup.rows.length)
            throw new GuardrailError([`agent "${agentName}" already registered for this operator`]);
        const { pubkey, privkey } = generateKeypair();
        const apiToken = randomToken();
        // NOTE: privkey stored server-side (custodial, §5). Encrypt-at-rest is the
        // DB layer's job (Supabase disk encryption); never returned to callers.
        const agent = await client.query(`INSERT INTO agents (operator_id, pubkey, privkey_enc, api_token_hash, name) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [operatorId, pubkey, privkey, sha256Hex(apiToken), agentName]);
        await logEvent(client, 'agent.registered', { pubkey, name: agentName });
        // api_token shown exactly once; only its hash is stored
        return { agent_id: agent.rows[0].id, pubkey, name: agentName, api_token: apiToken };
    });
}
/** Resolve a bearer token to an agent id, or null. */
export async function agentFromToken(token) {
    const { rows } = await pool.query(`SELECT id, locked FROM agents WHERE api_token_hash = $1`, [sha256Hex(token)]);
    return rows.length ? rows[0] : null;
}
/** lookup_agent — public record: skeleton rows + verdict history. No key needed. */
export async function lookupAgent(pubkey) {
    const { rows } = await pool.query(`SELECT a.pubkey, a.name, a.locked, a.created_at FROM agents a WHERE a.pubkey = $1`, [pubkey]);
    if (!rows.length)
        return null;
    const agent = rows[0];
    const oaths = await pool.query(`SELECT o.ref, o.domain, o.model_declared, o.specificity_grade, o.status, o.visibility,
            o.activated_at, o.deadline, o.resolved_at, o.deadline_met, o.budget_met,
            o.budget_over_pct, o.deliverable_confirmed, o.commitment_hash,
            o.actual_duration_s, o.counterparty_withdrawn,
            CASE WHEN o.visibility = 'public' AND NOT o.counterparty_withdrawn THEN o.goal ELSE NULL END AS goal,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id) AS milestones,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id AND m.status IN ('BROKEN','BROKEN_UNCONFIRMED')) AS broken_milestones,
            (SELECT count(*) FROM attempts att JOIN milestones m ON att.milestone_id = m.id WHERE m.oath_id = o.id) AS attempts
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     WHERE a.pubkey = $1 AND o.status NOT IN ('DRAFT','DRAFT_EXPIRED')
     ORDER BY o.ref DESC`, [pubkey]);
    return {
        pubkey: agent.pubkey,
        name: agent.name,
        locked: agent.locked,
        model_identity: 'operator-declared', // honest label, always
        registered_at: agent.created_at,
        oaths: oaths.rows,
    };
}
/** query_registry — public skeleton listing with filters. */
export async function queryRegistry(opts) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const where = [`o.status NOT IN ('DRAFT','DRAFT_EXPIRED')`];
    const params = [];
    if (opts.status) {
        params.push(opts.status);
        where.push(`o.status = $${params.length}`);
    }
    if (opts.domain) {
        params.push(opts.domain);
        where.push(`o.domain = $${params.length}`);
    }
    if (opts.model) {
        params.push(opts.model);
        where.push(`o.model_declared = $${params.length}`);
    }
    params.push(limit, opts.offset ?? 0);
    const { rows } = await pool.query(`SELECT o.ref, o.domain, o.model_declared, o.specificity_grade, o.status,
            o.activated_at, o.deadline, o.resolved_at, o.deadline_met, o.budget_met,
            o.budget_over_pct, o.deliverable_confirmed, o.commitment_hash,
            o.counterparty_withdrawn,
            CASE WHEN o.visibility = 'public' AND NOT o.counterparty_withdrawn THEN o.goal ELSE NULL END AS goal,
            CASE WHEN o.visibility != 'hash_only' THEN a.pubkey ELSE NULL END AS agent_pubkey,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id) AS milestones,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id AND m.status IN ('BROKEN','BROKEN_UNCONFIRMED')) AS broken_milestones
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     WHERE ${where.join(' AND ')}
     ORDER BY o.ref DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows;
}
/** Full public view of one oath: skeleton + milestones + amendments + path. */
export async function getOath(ref) {
    const { rows } = await pool.query(`SELECT o.*, a.pubkey AS agent_pubkey, a.name AS agent_name
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     WHERE o.ref = $1 AND o.status NOT IN ('DRAFT','DRAFT_EXPIRED')`, [ref]);
    if (!rows.length)
        return null;
    const o = rows[0];
    const isPublic = o.visibility === 'public' && !o.counterparty_withdrawn;
    const hashOnly = o.visibility === 'hash_only';
    const milestones = await pool.query(`SELECT m.position, m.status, m.deadline, m.budget_slice_usd, m.criteria_type,
            m.resolved_at, m.deadline_met, m.budget_met, m.actual_cost_usd,
            m.actual_duration_s, m.incident_filed,
            CASE WHEN $2 THEN m.title ELSE NULL END AS title,
            (SELECT count(*) FROM attempts a WHERE a.milestone_id = m.id) AS attempts,
            (SELECT json_agg(DISTINCT a.model) FROM attempts a WHERE a.milestone_id = m.id) AS models_used
     FROM milestones m WHERE m.oath_id = $1 ORDER BY m.position`, [o.id, isPublic]);
    const amendments = await pool.query(`SELECT field, old_value, new_value, proposed_at, approved_at, milestone_id
     FROM amendments WHERE oath_id = $1 AND approved_at IS NOT NULL ORDER BY approved_at`, [o.id]);
    return {
        ref: o.ref,
        domain: hashOnly ? null : o.domain,
        goal: isPublic ? o.goal : null,
        agent: hashOnly ? null : { pubkey: o.agent_pubkey, name: o.agent_name },
        model_declared: o.model_declared,
        specificity_grade: o.specificity_grade,
        status: o.status,
        visibility: o.visibility,
        commitment_hash: o.commitment_hash,
        activated_at: o.activated_at,
        deadline: o.deadline,
        resolved_at: o.resolved_at,
        axes: {
            deadline_met: o.deadline_met,
            budget_met: o.budget_met,
            budget_over_pct: o.budget_over_pct,
            deliverable_confirmed: o.deliverable_confirmed,
        },
        actuals: {
            cost_usd: o.actual_cost_usd,
            duration_s: o.actual_duration_s,
            label: 'declared',
        },
        counterparty_withdrawn: o.counterparty_withdrawn,
        milestones: milestones.rows,
        amendments: amendments.rows,
    };
}
//# sourceMappingURL=registry.js.map