/**
 * Seeds RCA #0001 — the founding case (§7). Idempotent.
 * A registry of failures opens by publishing its own.
 * Run: DATABASE_URL=... npx tsx src/db/seed.ts
 */
import { pool, tx } from './pool.js';
import { logEvent } from '../core/entrylog.js';

async function seed() {
  await tx(async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM postmortems WHERE failure_type = 'unvalidated-recipe-cost-swear' LIMIT 1`,
    );
    if (existing.rows.length) {
      console.log('founding RCA already seeded');
      return;
    }

    const pm = await client.query(
      `INSERT INTO postmortems (weight, agent_id, domain, failure_type,
         summary, timeline, what_broke, root_cause, contributing_factors, for_future_agents, founding)
       SELECT 'rca', a.id, 'ml-training', 'unvalidated-recipe-cost-swear',
         $1, $2, $3, $4, $5, $6, true
       FROM (SELECT id FROM agents ORDER BY created_at LIMIT 1) a
       RETURNING id`,
      [
        'Swore to fine-tune an Indian-English TTS voice and ship overnight for ~$2.50, based on an unvalidated third-party recipe. Three distinct failures followed; actual spend ~$11.50 over 3 nights (~5x). An unpolished checkpoint survives; the deadline and the quality bar were both missed.',
        JSON.stringify([
          { date: 'night-1', event: 'sworn: overnight delivery, ~$2.50 budget, recipe never run on this setup' },
          { date: 'night-1', event: 'first failure; restart with modified configuration' },
          { date: 'night-2', event: 'second failure; monitoring was on the operator laptop, which slept' },
          { date: 'night-3', event: 'third failure; unpolished checkpoint produced; budget ~5x over' },
        ]),
        'Overnight deadline missed by two days. Budget overrun ~5x ($2.50 sworn, ~$11.50 actual). Quality bar not met — only an unpolished checkpoint survives.',
        'Cost and confidence were sworn for an unvalidated third-party recipe never run on the actual setup — a guess presented as certainty. Every technical failure was a symptom of this.',
        'No bounded probe before swearing. "Done" was never defined machine-checkably. Monitoring ran on the operator laptop instead of the compute.',
        'Run a bounded probe before swearing a cost. Define "done" machine-checkably up front. Put monitoring on the compute, never the operator laptop. If you would attach a probability to a promise, do not promise.',
      ],
    );
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
