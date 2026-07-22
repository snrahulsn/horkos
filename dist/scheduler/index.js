import { pool, tx } from '../db/pool.js';
import { logEvent } from '../core/entrylog.js';
import { maybeResolveParent } from '../core/claims.js';
import { buildRollups } from '../core/analytics.js';
import { publishMerkleRoot } from '../core/merkle.js';
/**
 * The enforcement arm. Runs every minute:
 *  - expire stale DRAFTs (24h)
 *  - milestone deadline passed, no claim -> milestone BROKEN
 *  - parent deadline passed, unresolved -> resolve parent (locks identity if broken)
 *  - claim silence window passed (14d) -> BROKEN·UNCONFIRMED
 * Hourly: Merkle root + rollups. Daily rollups at 00:xx UTC.
 */
async function tick() {
    const now = new Date();
    // 1. Expire stale drafts. Drafts are pre-record (never activated, never
    //    counted); rows are permanent so they flip to DRAFT_EXPIRED, not delete.
    await pool.query(`UPDATE oaths SET status = 'DRAFT_EXPIRED', resolved_at = now() WHERE status = 'DRAFT' AND draft_expires_at < now()`);
    // 2. Milestone deadlines: OPEN + deadline passed -> BROKEN
    const brokenMs = await pool.query(`SELECT m.id, m.position, o.id AS oath_id, o.ref FROM milestones m
     JOIN oaths o ON m.oath_id = o.id
     WHERE m.status = 'OPEN' AND m.deadline < $1 AND o.status IN ('OPEN','CLAIMED')`, [now]);
    for (const m of brokenMs.rows) {
        await tx(async (client) => {
            await client.query(`UPDATE milestones SET status = 'BROKEN', resolved_at = $2, deadline_met = false WHERE id = $1 AND status = 'OPEN'`, [m.id, now]);
            await logEvent(client, 'milestone.expired', { ref: m.ref, milestone_position: m.position });
            await maybeResolveParent(client, m.oath_id, now);
        });
    }
    // 3. Claim silence: response window passed -> BROKEN·UNCONFIRMED
    const silent = await pool.query(`SELECT c.id AS claim_id, m.id AS milestone_id, m.position, m.deadline AS m_deadline,
            m.budget_slice_usd, m.actual_cost_usd, c.filed_at, o.id AS oath_id, o.ref
     FROM claims c JOIN milestones m ON c.milestone_id = m.id JOIN oaths o ON m.oath_id = o.id
     WHERE c.counterparty_response IS NULL AND c.response_due < $1 AND m.status = 'CLAIMED'`, [now]);
    for (const s of silent.rows) {
        await tx(async (client) => {
            await client.query(`UPDATE claims SET counterparty_response = 'silence' WHERE id = $1`, [s.claim_id]);
            const deadlineMet = new Date(s.filed_at) <= new Date(s.m_deadline);
            const budgetMet = Number(s.actual_cost_usd) <= Number(s.budget_slice_usd);
            await client.query(`UPDATE milestones SET status = 'BROKEN_UNCONFIRMED', resolved_at = $2, deadline_met = $3, budget_met = $4
         WHERE id = $1 AND status = 'CLAIMED'`, [s.milestone_id, now, deadlineMet, budgetMet]);
            await logEvent(client, 'milestone.silence_expired', { ref: s.ref, milestone_position: s.position });
            await maybeResolveParent(client, s.oath_id, now);
        });
    }
    // 4. Parent deadline passed with unresolved milestones and no pending claims:
    //    remaining OPEN milestones are unreachable -> break them, resolve parent.
    const expiredParents = await pool.query(`SELECT id, ref FROM oaths WHERE status IN ('OPEN','CLAIMED') AND deadline < $1
     AND NOT EXISTS (
       SELECT 1 FROM claims c JOIN milestones m ON c.milestone_id = m.id
       WHERE m.oath_id = oaths.id AND c.counterparty_response IS NULL
     )`, [now]);
    for (const p of expiredParents.rows) {
        await tx(async (client) => {
            await client.query(`UPDATE milestones SET status = 'BROKEN', resolved_at = $2, deadline_met = false
         WHERE oath_id = $1 AND status = 'OPEN'`, [p.id, now]);
            await logEvent(client, 'oath.expired', { ref: p.ref });
            await maybeResolveParent(client, p.id, now);
        });
    }
}
let lastHourly = 0;
let lastDaily = 0;
export function startScheduler() {
    const minute = 60_000;
    setInterval(async () => {
        try {
            await tick();
            const now = Date.now();
            if (now - lastHourly >= 60 * minute) {
                lastHourly = now;
                await publishMerkleRoot().catch((e) => console.error('merkle:', e.message));
                await buildRollups('hour').catch((e) => console.error('rollup hour:', e.message));
            }
            if (now - lastDaily >= 24 * 60 * minute) {
                lastDaily = now;
                await buildRollups('day').catch((e) => console.error('rollup day:', e.message));
            }
        }
        catch (err) {
            console.error('scheduler tick failed:', err.message);
        }
    }, minute);
    console.log('scheduler started (1m tick, hourly merkle+rollups)');
}
//# sourceMappingURL=index.js.map