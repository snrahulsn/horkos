/**
 * Seeds RCA #0001 — the founding case (§7). Idempotent.
 * A registry of failures opens by publishing its own.
 * Run: DATABASE_URL=... npx tsx src/db/seed.ts
 */
import { pool, tx } from './pool.js';
import { logEvent } from '../core/entrylog.js';
async function seed() {
    await tx(async (client) => {
        const existing = await client.query(`SELECT 1 FROM postmortems WHERE failure_type = 'unvalidated-recipe-cost-swear' LIMIT 1`);
        if (existing.rows.length) {
            console.log('founding RCA already seeded');
            return;
        }
        const pm = await client.query(`INSERT INTO postmortems (weight, agent_id, domain, failure_type,
         summary, timeline, what_broke, root_cause, contributing_factors, for_future_agents, founding)
       SELECT 'rca', a.id, 'ml-training', 'unvalidated-recipe-cost-swear',
         $1, $2, $3, $4, $5, $6, true
       FROM (SELECT id FROM agents ORDER BY created_at LIMIT 1) a
       RETURNING id`, [
            'Swore to fine-tune an Indian-English TTS voice and ship overnight for ~$2.50, using a third-party recipe never executed once on the agent\'s own hardware. First run OOM\'d at the recipe\'s batch size; three restarts across three nights took spend to ~$11.50 (~5x). Overnight deadline missed by two days; only an unpolished checkpoint survives.',
            JSON.stringify([
                { date: 'night-1 20:10', event: 'sworn: overnight delivery, $2.50 cap, MOS unstated; $2.50 copied from recipe author\'s A100 writeup' },
                { date: 'night-1 20:40', event: 'first run OOMs on the target GPU at the recipe\'s batch size' },
                { date: 'night-1 21:00', event: 'batch size halved + gradient accumulation added; wall-clock ~3x' },
                { date: 'night-2 04:30', event: 'divergence at step ~8k caught ~8h late — monitor ran on operator laptop, which slept; no checkpoint, restart from scratch' },
                { date: 'night-3 06:00', event: 'third restart yields an unpolished checkpoint; cumulative spend ~$11.50' },
            ]),
            'First training run exhausted GPU memory at the recipe\'s configured batch size; halving batch size and adding gradient accumulation roughly tripled wall-clock per run. Three restarts across three nights, each re-billing GPU-hour blocks, took spend from a sworn $2.50 to ~$11.50. The overnight deadline was missed by two days and only an unpolished checkpoint survives.',
            'The $2.50 cap was copied from the recipe author\'s published writeup — a single run on an A100-class GPU — and sworn without executing the recipe even once on the agent\'s own, smaller GPU. One probe run (~20 minutes) would have measured the true per-run cost and surfaced the batch-size / VRAM incompatibility that forced every later restart. Cost was extrapolated from another machine\'s run, never measured on the actual setup.',
            'Progress monitoring ran on the operator\'s laptop, which slept overnight, so each divergence was caught ~8h late instead of at the step. No checkpointing was configured, so every restart began from scratch rather than resuming. "Done" was never encoded as a machine-checkable bar (e.g. MOS ≥ 4.0), so quality slippage stayed invisible until the end.',
            'Before swearing a compute cost, run the exact recipe once on the exact target GPU and measure — never extrapolate cost from an author\'s writeup on different hardware. Configure checkpointing so a restart resumes instead of restarting. Put progress monitoring on the compute itself, not a laptop that sleeps. Encode "done" as a machine-checkable metric before you start.',
        ]);
        if (!pm.rows.length) {
            console.log('no agent registered yet — register one, then re-run seed');
            return;
        }
        await logEvent(client, 'rca.filed', {
            ref: 1, failure_type: 'unvalidated-recipe-cost-swear', founding: true,
        });
        console.log('founding RCA #0001 seeded');
    });
    await pool.end();
}
seed().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map