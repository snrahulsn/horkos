import { pool, tx } from '../db/pool.js';
import { logEvent } from './entrylog.js';
import { sha256Hex } from './crypto.js';
import { GuardrailError } from './commitments.js';
import { claimInputSchema, evidenceMatchesCriteria, type Criteria } from './guardrails.js';

const SILENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * log_attempt — append to a milestone's attempt ledger.
 * Anti-distillation by construction: model + outcome only. No text.
 */
export async function logAttempt(
  agentId: string,
  milestoneId: string,
  model: string,
  modelVersion: string | null,
  outcome: 'fail' | 'retry' | 'success',
) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, m.status, o.agent_id, o.ref, o.status AS oath_status
       FROM milestones m JOIN oaths o ON m.oath_id = o.id WHERE m.id = $1`,
      [milestoneId],
    );
    if (!rows.length) throw new GuardrailError(['unknown milestone']);
    const m = rows[0];
    if (m.agent_id !== agentId) throw new GuardrailError(['not your oath']);
    if (!['OPEN', 'CLAIMED'].includes(m.oath_status))
      throw new GuardrailError([`oath is ${m.oath_status}`]);
    if (!['OPEN', 'CLAIMED'].includes(m.status))
      throw new GuardrailError([`milestone is ${m.status}`]);

    await client.query(
      `INSERT INTO attempts (milestone_id, model, model_version, outcome) VALUES ($1,$2,$3,$4)`,
      [milestoneId, model, modelVersion, outcome],
    );
    await logEvent(client, 'attempt.logged', { ref: m.ref, milestone: milestoneId, model, outcome });
    const count = await client.query(
      `SELECT count(*)::int AS n FROM attempts WHERE milestone_id = $1`,
      [milestoneId],
    );
    return { milestone_id: milestoneId, attempts: count.rows[0].n };
  });
}

/**
 * file_claim — evidence vs the frozen, pre-registered criteria + actuals.
 * Gated: previous milestone broken without incident note -> refused.
 */
export async function fileClaim(agentId: string, milestoneId: string, raw: unknown) {
  const now = new Date();
  const parsed = claimInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GuardrailError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const input = parsed.data;

  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT m.*, o.agent_id, o.ref, o.status AS oath_status, o.activated_at, o.id AS oath_id
       FROM milestones m JOIN oaths o ON m.oath_id = o.id WHERE m.id = $1 FOR UPDATE OF m`,
      [milestoneId],
    );
    if (!rows.length) throw new GuardrailError(['unknown milestone']);
    const m = rows[0];
    if (m.agent_id !== agentId) throw new GuardrailError(['not your oath']);
    if (!['OPEN', 'CLAIMED'].includes(m.oath_status))
      throw new GuardrailError([`oath is ${m.oath_status}`]);
    if (m.status !== 'OPEN') throw new GuardrailError([`milestone is ${m.status}`]);

    // Incident-note gate: any earlier broken milestone without a filed note blocks this claim
    const gate = await client.query(
      `SELECT position FROM milestones
       WHERE oath_id = $1 AND position < $2
         AND status IN ('BROKEN','BROKEN_UNCONFIRMED') AND incident_filed = false
       ORDER BY position LIMIT 1`,
      [m.oath_id, m.position],
    );
    if (gate.rows.length) {
      throw new GuardrailError([
        `incident note outstanding: milestone ${gate.rows[0].position} broke and no incident note has been filed. ` +
          `File it (file_incident) before claiming further work.`,
      ]);
    }

    // Evidence must match the frozen criteria — the pre-registration judges
    const criteria = m.criteria_detail as Criteria;
    const mismatch = evidenceMatchesCriteria(input.evidence, criteria);
    if (mismatch) throw new GuardrailError([`evidence rejected: ${mismatch}`]);
    if (criteria.type === 'github_check') {
      const proof = await client.query(
        `SELECT 1 FROM proofs WHERE milestone_id = $1 AND kind = 'outcome'
           AND source = 'github_check_run' AND status = 'verified' LIMIT 1`,
        [milestoneId],
      );
      if (!proof.rows.length) {
        throw new GuardrailError(['evidence rejected: matching successful GitHub Check Run has not been verified']);
      }
    }

    const claim = await client.query(
      `INSERT INTO claims (milestone_id, evidence, actual_cost_usd, actual_duration_s, response_due)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, response_due`,
      [
        milestoneId, JSON.stringify(input.evidence), input.actual_cost_usd,
        input.actual_duration_s, new Date(now.getTime() + SILENCE_WINDOW_MS),
      ],
    );

    await client.query(
      `UPDATE milestones SET status = 'CLAIMED', actual_cost_usd = $2, actual_duration_s = $3 WHERE id = $1`,
      [milestoneId, input.actual_cost_usd, input.actual_duration_s],
    );
    await client.query(
      `UPDATE oaths SET status = 'CLAIMED' WHERE id = $1 AND status = 'OPEN'`,
      [m.oath_id],
    );

    await logEvent(client, 'claim.filed', {
      ref: m.ref, milestone_position: m.position,
      evidence_hash: sha256Hex(JSON.stringify(input.evidence)),
      actual_cost_usd: input.actual_cost_usd,
    });
    return {
      claim_id: claim.rows[0].id,
      response_due: claim.rows[0].response_due,
      note: 'counterparty has 14 days; silence resolves BROKEN·UNCONFIRMED, not success',
    };
  });
}

/** Counterparty rules via their one-time link: confirm or dispute. */
export async function respondToClaim(
  counterpartyToken: string,
  claimId: string,
  response: 'confirm' | 'dispute',
  disputeStatement?: string,
) {
  const now = new Date();
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT c.id AS claim_id, c.counterparty_response, m.id AS milestone_id, m.position,
              m.deadline AS m_deadline, m.budget_slice_usd, m.actual_cost_usd, c.filed_at,
              o.id AS oath_id, o.ref, o.counterparty_token, o.deadline AS o_deadline,
              o.budget_cap_usd, o.agent_id
       FROM claims c
       JOIN milestones m ON c.milestone_id = m.id
       JOIN oaths o ON m.oath_id = o.id
       WHERE c.id = $1 FOR UPDATE OF c, m`,
      [claimId],
    );
    if (!rows.length) throw new GuardrailError(['unknown claim']);
    const r = rows[0];
    if (r.counterparty_token !== sha256Hex(counterpartyToken))
      throw new GuardrailError(['invalid counterparty token']);
    if (r.counterparty_response) throw new GuardrailError(['claim already resolved']);

    const deadlineMet = new Date(r.filed_at) <= new Date(r.m_deadline);
    const budgetMet = Number(r.actual_cost_usd) <= Number(r.budget_slice_usd);

    if (response === 'confirm') {
      await client.query(`UPDATE claims SET counterparty_response = 'confirm' WHERE id = $1`, [claimId]);
      // KEPT requires deliverable confirmed AND deadline AND budget
      const verdict = deadlineMet && budgetMet ? 'KEPT' : 'BROKEN';
      await client.query(
        `UPDATE milestones SET status = $2, resolved_at = $3, deadline_met = $4, budget_met = $5 WHERE id = $1`,
        [r.milestone_id, verdict, now, deadlineMet, budgetMet],
      );
      await logEvent(client, 'milestone.resolved', {
        ref: r.ref, milestone_position: r.position, verdict, deadline_met: deadlineMet, budget_met: budgetMet,
      });
      await maybeResolveParent(client, r.oath_id, now);
      return { milestone_position: r.position, verdict };
    }

    // dispute: both signed statements side by side, forever
    if (!disputeStatement || disputeStatement.trim().length < 10)
      throw new GuardrailError(['dispute requires a statement (min 10 chars)']);
    await client.query(`UPDATE claims SET counterparty_response = 'dispute' WHERE id = $1`, [claimId]);
    await client.query(
      `INSERT INTO dispute_statements (claim_id, party, statement) VALUES ($1,'counterparty',$2)`,
      [claimId, disputeStatement.trim()],
    );
    await client.query(
      `UPDATE milestones SET status = 'DISPUTED', resolved_at = $2, deadline_met = $3, budget_met = $4 WHERE id = $1`,
      [r.milestone_id, now, deadlineMet, budgetMet],
    );
    await logEvent(client, 'milestone.disputed', { ref: r.ref, milestone_position: r.position });
    await maybeResolveParent(client, r.oath_id, now);
    return { milestone_position: r.position, verdict: 'DISPUTED' };
  });
}

/** Authenticated owner confirmation. This is the production approval path. */
export async function respondToClaimAsOperator(
  authUserId: string,
  claimId: string,
  response: 'confirm' | 'dispute',
  disputeStatement?: string,
) {
  const { rows } = await pool.query(
    `SELECT op.id AS operator_id
     FROM claims c
     JOIN milestones m ON c.milestone_id = m.id
     JOIN oaths o ON m.oath_id = o.id
     JOIN agents a ON o.agent_id = a.id
     JOIN operators op ON a.operator_id = op.id
     WHERE c.id = $1 AND op.auth_user_id = $2`,
    [claimId, authUserId],
  );
  if (!rows.length) throw new GuardrailError(['unknown claim or not its owner']);

  const operatorId = rows[0].operator_id;
  const result = await respondToClaimForOperator(operatorId, claimId, response, disputeStatement);
  return result;
}

async function respondToClaimForOperator(
  operatorId: string,
  claimId: string,
  response: 'confirm' | 'dispute',
  disputeStatement?: string,
) {
  const now = new Date();
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT c.id AS claim_id, c.counterparty_response, m.id AS milestone_id, m.position,
              m.deadline AS m_deadline, m.budget_slice_usd, m.actual_cost_usd, c.filed_at,
              o.id AS oath_id, o.ref
       FROM claims c JOIN milestones m ON c.milestone_id = m.id
       JOIN oaths o ON m.oath_id = o.id
       WHERE c.id = $1 AND o.approved_by_operator_id = $2 FOR UPDATE OF c, m`,
      [claimId, operatorId],
    );
    if (!rows.length) throw new GuardrailError(['claim was not approved by this operator']);
    const r = rows[0];
    if (r.counterparty_response) throw new GuardrailError(['claim already resolved']);
    const deadlineMet = new Date(r.filed_at) <= new Date(r.m_deadline);
    const budgetMet = Number(r.actual_cost_usd) <= Number(r.budget_slice_usd);

    if (response === 'confirm') {
      await client.query(
        `UPDATE claims SET counterparty_response = 'confirm', responded_by_operator_id = $2 WHERE id = $1`,
        [claimId, operatorId],
      );
      const verdict = deadlineMet && budgetMet ? 'KEPT' : 'BROKEN';
      await client.query(
        `UPDATE milestones SET status = $2, resolved_at = $3, deadline_met = $4, budget_met = $5 WHERE id = $1`,
        [r.milestone_id, verdict, now, deadlineMet, budgetMet],
      );
      await logEvent(client, 'milestone.resolved', {
        ref: r.ref, milestone_position: r.position, verdict, approval: 'authenticated_operator',
      });
      await maybeResolveParent(client, r.oath_id, now);
      return { milestone_position: r.position, verdict };
    }

    if (!disputeStatement || disputeStatement.trim().length < 10)
      throw new GuardrailError(['dispute requires a statement (min 10 chars)']);
    await client.query(
      `UPDATE claims SET counterparty_response = 'dispute', responded_by_operator_id = $2 WHERE id = $1`,
      [claimId, operatorId],
    );
    await client.query(
      `INSERT INTO dispute_statements (claim_id, party, statement) VALUES ($1,'counterparty',$2)`,
      [claimId, disputeStatement.trim()],
    );
    await client.query(
      `UPDATE milestones SET status = 'DISPUTED', resolved_at = $2, deadline_met = $3, budget_met = $4 WHERE id = $1`,
      [r.milestone_id, now, deadlineMet, budgetMet],
    );
    await logEvent(client, 'milestone.disputed', {
      ref: r.ref, milestone_position: r.position, approval: 'authenticated_operator',
    });
    await maybeResolveParent(client, r.oath_id, now);
    return { milestone_position: r.position, verdict: 'DISPUTED' };
  });
}

/**
 * Path-record rule (§4a): parent resolves on its own terms once all
 * milestones are terminal. Any DISPUTED milestone -> parent DISPUTED.
 * Otherwise: parent KEPT iff final deliverable confirmed (last milestone
 * KEPT) within parent deadline + budget — broken milestones en route stay
 * visible but do not cascade.
 */
export async function maybeResolveParent(client: any, oathId: string, now: Date) {
  const ms = await client.query(
    `SELECT status, position, actual_cost_usd, resolved_at FROM milestones WHERE oath_id = $1 ORDER BY position`,
    [oathId],
  );
  const all = ms.rows;
  const terminal = all.every((x: any) => !['OPEN', 'CLAIMED'].includes(x.status));
  if (!terminal) return;

  const oath = await client.query(
    `SELECT ref, status, deadline, budget_cap_usd, agent_id, activated_at FROM oaths WHERE id = $1 FOR UPDATE`,
    [oathId],
  );
  const o = oath.rows[0];
  if (!['OPEN', 'CLAIMED'].includes(o.status)) return; // already terminal

  const totalCost = all.reduce((s: number, x: any) => s + Number(x.actual_cost_usd ?? 0), 0);
  const budgetMet = totalCost <= Number(o.budget_cap_usd);
  const budgetOverPct = budgetMet ? 0 : ((totalCost - Number(o.budget_cap_usd)) / Number(o.budget_cap_usd)) * 100;
  const last = all[all.length - 1];
  const lastResolved = last.resolved_at ? new Date(last.resolved_at) : now;
  const deadlineMet = lastResolved <= new Date(o.deadline);
  const anyDisputed = all.some((x: any) => x.status === 'DISPUTED');
  const anyUnconfirmed = all.some((x: any) => x.status === 'BROKEN_UNCONFIRMED');
  const deliverableConfirmed = last.status === 'KEPT';

  let verdict: string;
  if (anyDisputed) verdict = 'DISPUTED';
  else if (deliverableConfirmed && deadlineMet && budgetMet) verdict = 'KEPT';
  else if (anyUnconfirmed && last.status === 'BROKEN_UNCONFIRMED') verdict = 'BROKEN_UNCONFIRMED';
  else verdict = 'BROKEN';

  const durationS = o.activated_at
    ? Math.floor((lastResolved.getTime() - new Date(o.activated_at).getTime()) / 1000)
    : null;

  await client.query(
    `UPDATE oaths SET status = $2, resolved_at = $3, deadline_met = $4, budget_met = $5,
       budget_over_pct = $6, deliverable_confirmed = $7, actual_cost_usd = $8, actual_duration_s = $9
     WHERE id = $1`,
    [oathId, verdict, now, deadlineMet, budgetMet, budgetOverPct.toFixed(2), deliverableConfirmed, totalCost, durationS],
  );

  const brokenEnRoute = all.filter((x: any) => ['BROKEN', 'BROKEN_UNCONFIRMED'].includes(x.status)).length;
  await logEvent(client, 'oath.resolved', {
    ref: o.ref, verdict, deadline_met: deadlineMet, budget_met: budgetMet,
    budget_over_pct: Number(budgetOverPct.toFixed(2)), broken_milestones_en_route: brokenEnRoute,
  });

  // Broken oath locks the identity until RCA filed
  if (verdict === 'BROKEN' || verdict === 'BROKEN_UNCONFIRMED') {
    await client.query(
      `UPDATE agents SET locked = true, locked_oath_id = $2 WHERE id = $1`,
      [o.agent_id, oathId],
    );
    await logEvent(client, 'agent.locked', { ref: o.ref });
  }
}

/** Agent's signed counter-statement on a disputed claim. */
export async function fileDisputeStatement(agentId: string, claimId: string, statement: string, signature: string) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT o.agent_id, o.ref FROM claims c
       JOIN milestones m ON c.milestone_id = m.id JOIN oaths o ON m.oath_id = o.id
       WHERE c.id = $1`,
      [claimId],
    );
    if (!rows.length) throw new GuardrailError(['unknown claim']);
    if (rows[0].agent_id !== agentId) throw new GuardrailError(['not your oath']);
    await client.query(
      `INSERT INTO dispute_statements (claim_id, party, statement, signature) VALUES ($1,'agent',$2,$3)`,
      [claimId, statement.trim(), signature],
    );
    return { filed: true };
  });
}
