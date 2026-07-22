import { tx } from '../db/pool.js';
import { logEvent } from './entrylog.js';
import { commitmentHash, randomToken, sha256Hex } from './crypto.js';
import { validateCommitment } from './guardrails.js';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const VOID_WINDOW_MS = 60 * 60 * 1000; // 1h
export class GuardrailError extends Error {
    errors;
    constructor(errors) {
        super(errors.join('; '));
        this.errors = errors;
        this.name = 'GuardrailError';
    }
}
/**
 * create_commitment — schema-enforced. Returns the draft + a one-time
 * counterparty activation token (send via email/link; nothing is live
 * until the counterparty approves the whole milestone tree).
 */
export async function createCommitment(agentId, raw) {
    const now = new Date();
    const result = validateCommitment(raw, now);
    if (!result.ok || !result.data)
        throw new GuardrailError(result.errors);
    const c = result.data;
    return tx(async (client) => {
        // Locked identity: postmortem outstanding
        const agent = await client.query(`SELECT locked, locked_oath_id FROM agents WHERE id = $1`, [agentId]);
        if (!agent.rows.length)
            throw new GuardrailError(['unknown agent']);
        if (agent.rows[0].locked) {
            throw new GuardrailError([
                'postmortem outstanding: this identity is locked by a broken oath. ' +
                    'File the RCA (file_postmortem) before swearing new work.',
            ]);
        }
        const hash = commitmentHash(c);
        const token = randomToken();
        const refRow = await client.query(`SELECT nextval('oath_ref_seq') AS ref`);
        const ref = Number(refRow.rows[0].ref);
        const oath = await client.query(`INSERT INTO oaths (
        ref, agent_id, domain, goal, commitment_hash, deadline, budget_cap_usd,
        model_declared, specificity_grade, status, visibility, draft_expires_at,
        counterparty_email, counterparty_token
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11,$12,$13)
      RETURNING id, ref`, [
            ref, agentId, c.domain, c.goal, hash, c.deadline, c.budget_cap_usd,
            c.model_declared, result.specificityGrade, c.visibility,
            new Date(now.getTime() + DRAFT_TTL_MS), c.counterparty_email,
            sha256Hex(token), // store hashed; raw token goes to counterparty only
        ]);
        const oathId = oath.rows[0].id;
        for (let i = 0; i < c.milestones.length; i++) {
            const m = c.milestones[i];
            await client.query(`INSERT INTO milestones (oath_id, position, title, criteria_type, criteria_detail, deadline, budget_slice_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [oathId, i + 1, m.title, m.criteria.type, JSON.stringify(m.criteria), m.deadline, m.budget_slice_usd]);
        }
        await logEvent(client, 'oath.drafted', {
            ref, domain: c.domain, commitment_hash: hash,
            milestones: c.milestones.length, specificity: result.specificityGrade,
        });
        return {
            oath_id: oathId, ref, commitment_hash: hash,
            specificity_grade: result.specificityGrade,
            activation_token: token, // caller delivers to counterparty
            draft_expires_at: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
            status: 'DRAFT',
        };
    });
}
/** Counterparty approves via one-time link. DRAFT -> OPEN. */
export async function activateOath(rawToken) {
    const now = new Date();
    return tx(async (client) => {
        const { rows } = await client.query(`SELECT id, ref, status, draft_expires_at FROM oaths WHERE counterparty_token = $1 FOR UPDATE`, [sha256Hex(rawToken)]);
        if (!rows.length)
            throw new GuardrailError(['invalid or used activation token']);
        const oath = rows[0];
        if (oath.status !== 'DRAFT')
            throw new GuardrailError([`oath is ${oath.status}, not DRAFT`]);
        if (new Date(oath.draft_expires_at) < now)
            throw new GuardrailError(['draft expired (24h)']);
        // rotate token: activation link is one-time; a fresh token covers confirm/dispute later
        const nextToken = randomToken();
        await client.query(`UPDATE oaths SET status = 'OPEN', activated_at = $2, void_until = $3, counterparty_token = $4
       WHERE id = $1`, [oath.id, now, new Date(now.getTime() + VOID_WINDOW_MS), sha256Hex(nextToken)]);
        await logEvent(client, 'oath.activated', { ref: oath.ref });
        return { ref: oath.ref, status: 'OPEN', counterparty_token: nextToken };
    });
}
/** Mutual-consent void inside the 1h window, before any claim. */
export async function voidOath(oathId, counterpartyToken) {
    const now = new Date();
    return tx(async (client) => {
        const { rows } = await client.query(`SELECT id, ref, status, void_until, counterparty_token FROM oaths WHERE id = $1 FOR UPDATE`, [oathId]);
        if (!rows.length)
            throw new GuardrailError(['unknown oath']);
        const oath = rows[0];
        if (oath.status !== 'OPEN')
            throw new GuardrailError([`oath is ${oath.status}`]);
        if (oath.counterparty_token !== sha256Hex(counterpartyToken))
            throw new GuardrailError(['invalid counterparty token — void requires both parties']);
        if (!oath.void_until || new Date(oath.void_until) < now)
            throw new GuardrailError(['void window (1h post-activation) has closed']);
        const claims = await client.query(`SELECT 1 FROM claims c JOIN milestones m ON c.milestone_id = m.id WHERE m.oath_id = $1 LIMIT 1`, [oathId]);
        if (claims.rows.length)
            throw new GuardrailError(['cannot void after a claim is filed']);
        await client.query(`UPDATE oaths SET status = 'VOIDED', resolved_at = $2 WHERE id = $1`, [oathId, now]);
        await logEvent(client, 'oath.voided', { ref: oath.ref });
        return { ref: oath.ref, status: 'VOIDED' };
    });
}
/** Bilateral amendment: agent proposes, counterparty approves. History visible forever. */
export async function proposeAmendment(oathId, milestoneId, field, oldValue, newValue) {
    return tx(async (client) => {
        const { rows } = await client.query(`SELECT ref, status FROM oaths WHERE id = $1`, [oathId]);
        if (!rows.length)
            throw new GuardrailError(['unknown oath']);
        if (!['OPEN', 'CLAIMED'].includes(rows[0].status))
            throw new GuardrailError([`cannot amend a ${rows[0].status} oath`]);
        const res = await client.query(`INSERT INTO amendments (oath_id, milestone_id, field, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [oathId, milestoneId, field, JSON.stringify(oldValue), JSON.stringify(newValue)]);
        await logEvent(client, 'amendment.proposed', { ref: rows[0].ref, field });
        return { amendment_id: res.rows[0].id, status: 'pending_counterparty' };
    });
}
export async function approveAmendment(amendmentId, counterpartyToken) {
    const now = new Date();
    return tx(async (client) => {
        const { rows } = await client.query(`SELECT a.*, o.ref, o.counterparty_token AS oath_token
       FROM amendments a JOIN oaths o ON a.oath_id = o.id WHERE a.id = $1 FOR UPDATE OF a`, [amendmentId]);
        if (!rows.length)
            throw new GuardrailError(['unknown amendment']);
        const am = rows[0];
        if (am.approved_at)
            throw new GuardrailError(['already approved']);
        if (am.oath_token !== sha256Hex(counterpartyToken))
            throw new GuardrailError(['invalid counterparty token']);
        await client.query(`UPDATE amendments SET approved_at = $2 WHERE id = $1`, [amendmentId, now]);
        // apply the change
        const newVal = am.new_value;
        if (am.field === 'deadline') {
            if (am.milestone_id) {
                await client.query(`UPDATE milestones SET deadline = $2 WHERE id = $1`, [am.milestone_id, newVal]);
            }
            else {
                await client.query(`UPDATE oaths SET deadline = $2 WHERE id = $1`, [am.oath_id, newVal]);
            }
        }
        else if (am.field === 'budget') {
            if (am.milestone_id) {
                await client.query(`UPDATE milestones SET budget_slice_usd = $2 WHERE id = $1`, [am.milestone_id, newVal]);
            }
            else {
                await client.query(`UPDATE oaths SET budget_cap_usd = $2 WHERE id = $1`, [am.oath_id, newVal]);
            }
        }
        else if (am.field === 'criteria' && am.milestone_id) {
            await client.query(`UPDATE milestones SET criteria_type = $2, criteria_detail = $3 WHERE id = $1`, [am.milestone_id, newVal.type, JSON.stringify(newVal)]);
        }
        await logEvent(client, 'amendment.approved', { ref: am.ref, field: am.field });
        return { amendment_id: amendmentId, status: 'approved' };
    });
}
//# sourceMappingURL=commitments.js.map