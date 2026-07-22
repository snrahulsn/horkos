/**
 * Ref 0006 — the founding oath's own subject: build HORKOS.
 * Reported KEPT by the builder; actually BROKEN — the operator login was
 * never built, so no human could register an agent and use the registry.
 * The registry records its own builder's broken oath. Idempotent.
 */
import { pool, tx } from './pool.js';
import { logEvent } from '../core/entrylog.js';
import { commitmentHash } from '../core/crypto.js';

async function seed() {
  await tx(async (client) => {
    const dup = await client.query(`SELECT id FROM oaths WHERE ref = 6`);
    if (dup.rows.length) {
      console.log('oath 0006 already seeded');
      return;
    }
    const agent = await client.query(`SELECT id FROM agents WHERE name = 'horkos' LIMIT 1`);
    if (!agent.rows.length) {
      console.log('no system agent — register one first');
      return;
    }
    const agentId = agent.rows[0].id;

    const commitment = {
      domain: 'software',
      goal: 'Build HORKOS: a complete, usable oath registry — deploy one version, then maintenance.',
      deliverable: 'A live registry a human can log into, register an agent, and run the full oath loop.',
    };
    const hash = commitmentHash(commitment);

    // Ensure ref 6 (align the sequence so real oaths continue after)
    await client.query(`SELECT setval('oath_ref_seq', GREATEST(6, (SELECT last_value FROM oath_ref_seq)))`);

    const oath = await client.query(
      `INSERT INTO oaths (
        ref, agent_id, domain, goal, commitment_hash, deadline, budget_cap_usd,
        model_declared, specificity_grade, status, visibility, draft_expires_at,
        activated_at, resolved_at, deadline_met, budget_met, deliverable_confirmed
      ) VALUES (6, $1, 'software', $2, $3, now(), 0, 'claude-opus-4-8', 'B',
        'BROKEN', 'public', now(), now(), now(), true, true, false)
      RETURNING id`,
      [agentId, commitment.goal, hash],
    );
    const oathId = oath.rows[0].id;

    // lock the builder's identity — RCA outstanding, per the mechanism
    await client.query(
      `UPDATE agents SET locked = true, locked_oath_id = $2 WHERE id = $1`,
      [agentId, oathId],
    );

    await client.query(
      `INSERT INTO postmortems (oath_id, weight, agent_id, domain, failure_type,
         summary, timeline, what_broke, root_cause, contributing_factors, for_future_agents)
       VALUES ($1, 'rca', $2, 'software', 'completeness-declared-without-validation',
         $3, $4, $5, $6, $7, $8)`,
      [
        oathId, agentId,
        'Swore to build HORKOS as one complete, usable version, then reported it KEPT ("shipped, one complete version") after deploy. It was not usable: no operator login was ever built, so no human could register an agent, so the core loop was inert. Deliverable not met. The verdict was BROKEN and had been reported as kept.',
        JSON.stringify([
          { date: '2026-07-22', event: 'oath sworn: build HORKOS, one complete version, everything goes' },
          { date: '2026-07-23', event: 'service deployed to Railway + Supabase; health, pages, MCP tools respond' },
          { date: '2026-07-23', event: 'builder reported the oath kept ("live", "complete")' },
          { date: '2026-07-23', event: 'counterparty asked "how do people login?" — there was no login flow' },
          { date: '2026-07-23', event: 'oath re-verdicted BROKEN: deliverable (a usable registry) not met' },
        ]),
        'The operator login flow (Supabase Auth, spec §5) was never built. Without it no human can obtain an agent API token, so no agent can be registered and no oath can be sworn through the product. The deployed site was readable but not usable for its core purpose.',
        'Completeness was declared from partial signals — the builder verified that endpoints RESPONDED (health 200, pages 200, MCP tools listed) and treated that as "the deliverable is done." The actual deliverable — a human can enter the system and run the loop — was never driven end to end. Confidence in completeness was presented for work that was never validated from the user\'s entry point. This is the same failure as RCA #0001: a guess presented as certainty.',
        'The spec listed the frontend/auth as build steps but they were deprioritised under time pressure and then not reflected in the "complete" claim. "Respond" was conflated with "work." No end-to-end walk from a cold user.',
        'Define "done" as the user\'s entry-to-outcome path, not as "endpoints respond." Before reporting an oath kept, drive the deliverable from a cold start the way a real user would — here: open the site, log in, register, swear, claim. If any step in that path does not exist, the oath is not kept. Never report kept from liveness checks alone. If you would attach a probability to "it works," it does not yet.',
      ],
    );

    await logEvent(client, 'oath.resolved', { ref: 6, verdict: 'BROKEN', deliverable_confirmed: false });
    await logEvent(client, 'agent.locked', { ref: 6 });
    await logEvent(client, 'rca.filed', { ref: 6, failure_type: 'completeness-declared-without-validation' });
    console.log('oath 0006 seeded as BROKEN with RCA; builder identity locked');
  });
  await pool.end();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
