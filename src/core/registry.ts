import { pool, tx } from '../db/pool.js';
import { randomToken, sha256Hex } from './crypto.js';
import { logEvent } from './entrylog.js';
import { GuardrailError } from './commitments.js';

/** register_agent — one-time; binds operator OAuth identity, issues custodial keypair. */
export async function registerAgent(authUserId: string, agentName: string, displayName?: string) {
  return tx(async (client) => {
    let op = await client.query(`SELECT id FROM operators WHERE auth_user_id = $1`, [authUserId]);
    let operatorId: string;
    if (op.rows.length) {
      operatorId = op.rows[0].id;
    } else {
      const created = await client.query(
        `INSERT INTO operators (auth_user_id, display_name) VALUES ($1,$2) RETURNING id`,
        [authUserId, displayName ?? null],
      );
      operatorId = created.rows[0].id;
    }

    const dup = await client.query(
      `SELECT 1 FROM agents WHERE operator_id = $1 AND name = $2`,
      [operatorId, agentName],
    );
    if (dup.rows.length) throw new GuardrailError([`agent "${agentName}" already registered for this operator`]);

    // Stable public identifier. It is deliberately not described as a signing
    // identity until an external attestation provider proves key custody.
    const pubkey = randomToken();
    const apiToken = randomToken();
    const agent = await client.query(
      `INSERT INTO agents (operator_id, pubkey, privkey_enc, api_token_hash, name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [operatorId, pubkey, 'not-issued', sha256Hex(apiToken), agentName],
    );
    await logEvent(client, 'agent.registered', { pubkey, name: agentName });
    // api_token shown exactly once; only its hash is stored
    return { agent_id: agent.rows[0].id, pubkey, name: agentName, api_token: apiToken };
  });
}

/** Resolve a bearer token to an agent id, or null. */
export async function agentFromToken(token: string): Promise<{ id: string; locked: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT id, locked FROM agents WHERE api_token_hash = $1`,
    [sha256Hex(token)],
  );
  return rows.length ? rows[0] : null;
}

/** lookup_agent — public record: skeleton rows + verdict history. No key needed. */
export async function lookupAgent(pubkey: string) {
  const { rows } = await pool.query(
    `SELECT a.pubkey, a.name, a.locked, a.created_at FROM agents a WHERE a.pubkey = $1`,
    [pubkey],
  );
  if (!rows.length) return null;
  const agent = rows[0];

  const oaths = await pool.query(
    `SELECT o.ref, CASE WHEN o.visibility = 'public' AND NOT o.counterparty_withdrawn THEN o.task_title ELSE NULL END AS task_title,
            o.domain, o.status, o.visibility,
            o.activated_at, o.deadline, o.resolved_at, o.deadline_met,
            CASE WHEN EXISTS (SELECT 1 FROM proofs p WHERE p.oath_id = o.id AND p.status = 'verified' AND p.kind = 'cost') THEN o.budget_met ELSE NULL END AS budget_met,
            CASE WHEN EXISTS (SELECT 1 FROM proofs p WHERE p.oath_id = o.id AND p.status = 'verified' AND p.kind = 'cost') THEN o.budget_over_pct ELSE NULL END AS budget_over_pct,
            o.deliverable_confirmed, o.commitment_hash,
            o.actual_duration_s, o.counterparty_withdrawn,
            CASE WHEN o.visibility = 'public' AND NOT o.counterparty_withdrawn THEN o.goal ELSE NULL END AS goal,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id) AS milestones,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id AND m.status IN ('BROKEN','BROKEN_UNCONFIRMED')) AS broken_milestones,
            (SELECT count(*) FROM proofs p WHERE p.oath_id = o.id AND p.status = 'verified' AND p.kind = 'evaluation_run') AS attempts
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     WHERE a.pubkey = $1
       AND o.status NOT IN ('DRAFT','DRAFT_EXPIRED')
       AND o.visibility NOT IN ('private','hash_only')
     ORDER BY o.ref DESC`,
    [pubkey],
  );

  return {
    pubkey: agent.pubkey,
    name: agent.name,
    locked: agent.locked,
    registered_at: agent.created_at,
    oaths: oaths.rows,
  };
}

/** query_registry — public skeleton listing with filters. */
export async function queryRegistry(opts: {
  query?: string;
  status?: string;
  domain?: string;
  model?: string;
  taskType?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const where: string[] = [
    `o.status NOT IN ('DRAFT','DRAFT_EXPIRED')`,
    `o.visibility != 'private'`,
  ];
  const params: unknown[] = [];

  if (opts.status) {
    params.push(opts.status);
    where.push(`o.status = $${params.length}`);
  }
  if (opts.domain) {
    params.push(opts.domain);
    // Concealed dimensions must not be discoverable as a filter oracle.
    where.push(`o.visibility != 'hash_only' AND o.domain = $${params.length}`);
  }
  if (opts.model) {
    params.push(opts.model);
    where.push(`o.visibility != 'hash_only' AND EXISTS (
      SELECT 1 FROM proofs model_proof WHERE model_proof.oath_id = o.id
        AND model_proof.status = 'verified' AND model_proof.kind = 'model_usage'
        AND model_proof.assertion->>'model' = $${params.length}
    )`);
  }
  if (opts.taskType) {
    params.push(opts.taskType);
    where.push(`o.visibility != 'hash_only' AND o.task_type = $${params.length}`);
  }
  if (opts.query?.trim()) {
    params.push(opts.query.trim());
    where.push(`o.visibility = 'public' AND to_tsvector('english', o.task_title || ' ' || o.domain) @@ websearch_to_tsquery('english', $${params.length})`);
  }
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT o.ref, CASE WHEN o.visibility = 'public' AND NOT o.counterparty_withdrawn THEN o.task_title ELSE NULL END AS task_title,
            o.task_type, o.risk_level, o.domain, o.status, o.visibility,
            o.activated_at, o.deadline, o.resolved_at, o.deadline_met,
            CASE WHEN EXISTS (SELECT 1 FROM proofs p WHERE p.oath_id = o.id AND p.status = 'verified' AND p.kind = 'cost') THEN o.budget_met ELSE NULL END AS budget_met,
            CASE WHEN EXISTS (SELECT 1 FROM proofs p WHERE p.oath_id = o.id AND p.status = 'verified' AND p.kind = 'cost') THEN o.budget_over_pct ELSE NULL END AS budget_over_pct,
            o.deliverable_confirmed, o.commitment_hash,
            o.counterparty_withdrawn,
            CASE WHEN o.visibility = 'public' AND NOT o.counterparty_withdrawn THEN o.goal ELSE NULL END AS goal,
            CASE WHEN o.visibility != 'hash_only' THEN a.pubkey ELSE NULL END AS agent_pubkey,
            count(*) OVER()::int AS total_count,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id) AS milestones,
            (SELECT count(*) FROM milestones m WHERE m.oath_id = o.id AND m.status IN ('BROKEN','BROKEN_UNCONFIRMED')) AS broken_milestones,
            (SELECT count(*) FROM proofs p WHERE p.oath_id = o.id AND p.status = 'verified') AS verified_proofs
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     WHERE ${where.join(' AND ')}
     ORDER BY o.ref DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((row) => {
    if (row.visibility !== 'hash_only') return row;
    return {
      ref: row.ref,
      status: row.status,
      visibility: row.visibility,
      commitment_hash: row.commitment_hash,
      activated_at: row.activated_at,
      resolved_at: row.resolved_at,
      total_count: row.total_count,
    };
  });
}

/** Full public view of one oath: skeleton + milestones + amendments + path. */
export async function getOath(ref: number) {
  const { rows } = await pool.query(
    `SELECT o.*, a.pubkey AS agent_pubkey, a.name AS agent_name
     FROM oaths o JOIN agents a ON o.agent_id = a.id
     WHERE o.ref = $1
       AND o.status NOT IN ('DRAFT','DRAFT_EXPIRED')
       AND o.visibility != 'private'`,
    [ref],
  );
  if (!rows.length) return null;
  const o = rows[0];
  const isPublic = o.visibility === 'public' && !o.counterparty_withdrawn;
  const hashOnly = o.visibility === 'hash_only';

  if (hashOnly) {
    return {
      ref: o.ref,
      status: o.status,
      visibility: o.visibility,
      commitment_hash: o.commitment_hash,
      activated_at: o.activated_at,
      resolved_at: o.resolved_at,
      // Preserve the public-view response shape without exposing data.
      domain: null,
      goal: null,
      task_title: null,
      agent: null,
      model_declared: null,
      specificity_grade: null,
      deadline: null,
      axes: {
        deadline_met: null,
        budget_met: null,
        budget_over_pct: null,
        deliverable_confirmed: null,
      },
      actuals: { cost_usd: null, duration_s: null, label: null },
      counterparty_withdrawn: false,
      milestones: [],
      amendments: [],
    };
  }

  const milestones = await pool.query(
    `SELECT m.position, m.status, m.deadline, m.budget_slice_usd, m.criteria_type,
            m.resolved_at, m.deadline_met,
            CASE WHEN EXISTS (SELECT 1 FROM proofs p WHERE p.milestone_id = m.id AND p.status = 'verified' AND p.kind = 'cost') THEN m.budget_met ELSE NULL END AS budget_met,
            CASE WHEN EXISTS (SELECT 1 FROM proofs p WHERE p.milestone_id = m.id AND p.status = 'verified' AND p.kind = 'cost') THEN m.actual_cost_usd ELSE NULL END AS actual_cost_usd,
            m.actual_duration_s, m.incident_filed,
            CASE WHEN $2 THEN m.title ELSE NULL END AS title,
            (SELECT count(*) FROM proofs p WHERE p.milestone_id = m.id AND p.status = 'verified' AND p.kind = 'evaluation_run') AS attempts,
            (SELECT json_agg(DISTINCT p.assertion->>'model') FROM proofs p
              WHERE p.milestone_id = m.id AND p.status = 'verified' AND p.kind = 'model_usage') AS models_used
     FROM milestones m WHERE m.oath_id = $1 ORDER BY m.position`,
    [o.id, isPublic],
  );

  const amendments = await pool.query(
    `SELECT field,
            CASE WHEN $2 THEN old_value ELSE NULL END AS old_value,
            CASE WHEN $2 THEN new_value ELSE NULL END AS new_value,
            proposed_at, approved_at, milestone_id
     FROM amendments WHERE oath_id = $1 AND approved_at IS NOT NULL ORDER BY approved_at`,
    [o.id, isPublic],
  );

  const proofKinds = await pool.query(
    `SELECT DISTINCT kind FROM proofs WHERE oath_id = $1 AND status = 'verified'`,
    [o.id],
  );
  const verifiedKinds = new Set(proofKinds.rows.map((row) => row.kind));
  const costVerified = verifiedKinds.has('cost');
  const verifiedModels = await pool.query(
    `SELECT DISTINCT assertion->>'model' AS model FROM proofs
     WHERE oath_id = $1 AND status = 'verified' AND kind = 'model_usage' AND assertion ? 'model'
     ORDER BY model`,
    [o.id],
  );

  return {
    ref: o.ref,
    task_title: isPublic ? o.task_title : null,
    domain: o.domain,
    goal: isPublic ? o.goal : null,
    agent: { pubkey: o.agent_pubkey, name: o.agent_name },
    verified_models: verifiedModels.rows.map((row) => row.model),
    specificity_grade: o.specificity_grade,
    status: o.status,
    visibility: o.visibility,
    commitment_hash: o.commitment_hash,
    activated_at: o.activated_at,
    deadline: o.deadline,
    resolved_at: o.resolved_at,
    axes: {
      deadline_met: o.deadline_met,
      budget_met: costVerified ? o.budget_met : null,
      budget_over_pct: costVerified ? o.budget_over_pct : null,
      deliverable_confirmed: o.deliverable_confirmed,
    },
    actuals: {
      cost_usd: costVerified ? o.actual_cost_usd : null,
      duration_s: o.actual_duration_s,
      label: costVerified ? 'verified' : null,
    },
    counterparty_withdrawn: o.counterparty_withdrawn,
    milestones: milestones.rows,
    amendments: amendments.rows,
  };
}
