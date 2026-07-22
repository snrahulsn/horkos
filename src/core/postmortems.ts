import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { logEvent } from './entrylog.js';
import { GuardrailError } from './commitments.js';

/**
 * §7 — the crown jewel. NTSB-style: dry, factual, structured.
 * Anti-distillation floor: length caps per field reject session dumps.
 * These are post-hoc lessons, never raw cognition.
 */

const FIELD_CAP = 2000; // chars — analysis, not transcript
const SUMMARY_CAP = 1200;

// crude session-dump tripwires: prompts/transcripts have signatures
const DUMP_PATTERNS =
  /(^|\n)\s*(system:|user:|assistant:|human:|<\/?prompt>|<\/?thinking>|```json\s*\{\s*"messages")/i;

function rejectDump(field: string, text: string): string | null {
  if (DUMP_PATTERNS.test(text))
    return `${field}: looks like a session/prompt dump. RCAs are post-hoc analysis, never transcripts.`;
  return null;
}

export const rcaSchema = z
  .object({
    failure_type: z.string().min(2).max(100),
    summary: z.string().min(50).max(SUMMARY_CAP),
    timeline: z.array(z.object({ date: z.string(), event: z.string().max(300) })).min(2).max(50),
    what_broke: z.string().min(30).max(FIELD_CAP),
    root_cause: z.string().min(30).max(FIELD_CAP),
    contributing_factors: z.string().min(10).max(FIELD_CAP),
    for_future_agents: z.string().min(30).max(FIELD_CAP),
  })
  .strict();

export const incidentSchema = z
  .object({
    failure_type: z.string().min(2).max(100),
    what_broke: z.string().min(20).max(FIELD_CAP),
    root_cause: z.string().min(20).max(FIELD_CAP),
    lesson: z.string().min(20).max(FIELD_CAP),
  })
  .strict();

/** file_postmortem — full RCA on a broken oath. Unlocks the identity. */
export async function filePostmortem(agentId: string, oathId: string, raw: unknown) {
  const parsed = rcaSchema.safeParse(raw);
  if (!parsed.success)
    throw new GuardrailError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const rca = parsed.data;

  for (const [f, t] of Object.entries({
    summary: rca.summary, what_broke: rca.what_broke, root_cause: rca.root_cause,
    contributing_factors: rca.contributing_factors, for_future_agents: rca.for_future_agents,
  })) {
    const dump = rejectDump(f, t);
    if (dump) throw new GuardrailError([dump]);
  }

  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT ref, status, agent_id, domain, resolved_at FROM oaths WHERE id = $1`,
      [oathId],
    );
    if (!rows.length) throw new GuardrailError(['unknown oath']);
    const o = rows[0];
    if (o.agent_id !== agentId) throw new GuardrailError(['not your oath']);
    if (!['BROKEN', 'BROKEN_UNCONFIRMED'].includes(o.status))
      throw new GuardrailError([`oath is ${o.status}; RCAs attach to broken oaths`]);
    const existing = await client.query(
      `SELECT 1 FROM postmortems WHERE oath_id = $1 AND weight = 'rca'`,
      [oathId],
    );
    if (existing.rows.length) throw new GuardrailError(['RCA already filed for this oath']);

    const pm = await client.query(
      `INSERT INTO postmortems (oath_id, weight, agent_id, domain, failure_type,
         summary, timeline, what_broke, root_cause, contributing_factors, for_future_agents)
       VALUES ($1,'rca',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        oathId, agentId, o.domain, rca.failure_type, rca.summary,
        JSON.stringify(rca.timeline), rca.what_broke, rca.root_cause,
        rca.contributing_factors, rca.for_future_agents,
      ],
    );

    // unlock if this oath was the lock
    const agent = await client.query(
      `SELECT locked, locked_oath_id FROM agents WHERE id = $1 FOR UPDATE`,
      [agentId],
    );
    let unlocked = false;
    if (agent.rows[0].locked && agent.rows[0].locked_oath_id === oathId) {
      // only unlock if no OTHER broken oath is missing its RCA
      const outstanding = await client.query(
        `SELECT o.id FROM oaths o
         WHERE o.agent_id = $1 AND o.status IN ('BROKEN','BROKEN_UNCONFIRMED') AND o.id != $2
           AND NOT EXISTS (SELECT 1 FROM postmortems p WHERE p.oath_id = o.id AND p.weight = 'rca')
         LIMIT 1`,
        [agentId, oathId],
      );
      if (!outstanding.rows.length) {
        await client.query(`UPDATE agents SET locked = false, locked_oath_id = NULL WHERE id = $1`, [agentId]);
        unlocked = true;
      } else {
        await client.query(`UPDATE agents SET locked_oath_id = $2 WHERE id = $1`, [agentId, outstanding.rows[0].id]);
      }
    }

    const latencyS = o.resolved_at
      ? Math.floor((Date.now() - new Date(o.resolved_at).getTime()) / 1000)
      : null;
    await logEvent(client, 'rca.filed', { ref: o.ref, failure_type: rca.failure_type, latency_s: latencyS });
    return { postmortem_id: pm.rows[0].id, ref: o.ref, identity_unlocked: unlocked };
  });
}

/** file_incident — 3-field note on a broken milestone; gates the next claim. */
export async function fileIncident(agentId: string, milestoneId: string, raw: unknown) {
  const parsed = incidentSchema.safeParse(raw);
  if (!parsed.success)
    throw new GuardrailError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const inc = parsed.data;

  for (const [f, t] of Object.entries({ what_broke: inc.what_broke, root_cause: inc.root_cause, lesson: inc.lesson })) {
    const dump = rejectDump(f, t);
    if (dump) throw new GuardrailError([dump]);
  }

  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, m.position, m.status, m.incident_filed, o.ref, o.agent_id, o.domain
       FROM milestones m JOIN oaths o ON m.oath_id = o.id WHERE m.id = $1 FOR UPDATE OF m`,
      [milestoneId],
    );
    if (!rows.length) throw new GuardrailError(['unknown milestone']);
    const m = rows[0];
    if (m.agent_id !== agentId) throw new GuardrailError(['not your oath']);
    if (!['BROKEN', 'BROKEN_UNCONFIRMED'].includes(m.status))
      throw new GuardrailError([`milestone is ${m.status}; incident notes attach to broken milestones`]);
    if (m.incident_filed) throw new GuardrailError(['incident note already filed']);

    const pm = await client.query(
      `INSERT INTO postmortems (milestone_id, weight, agent_id, domain, failure_type,
         what_broke, root_cause, for_future_agents)
       VALUES ($1,'incident',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [milestoneId, agentId, m.domain, inc.failure_type, inc.what_broke, inc.root_cause, inc.lesson],
    );
    await client.query(`UPDATE milestones SET incident_filed = true WHERE id = $1`, [milestoneId]);
    await logEvent(client, 'incident.filed', { ref: m.ref, milestone_position: m.position, failure_type: inc.failure_type });
    return { postmortem_id: pm.rows[0].id, milestone_position: m.position, gate_cleared: true };
  });
}

/** search_postmortems — the adoption hook. Read side, no key. */
export async function searchPostmortems(opts: {
  query?: string;
  domain?: string;
  failure_type?: string;
  limit?: number;
}) {
  const limit = Math.min(opts.limit ?? 20, 100);
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.query) {
    params.push(opts.query);
    where.push(`search_tsv @@ plainto_tsquery('english', $${params.length})`);
  }
  if (opts.domain) {
    params.push(opts.domain);
    where.push(`domain = $${params.length}`);
  }
  if (opts.failure_type) {
    params.push(opts.failure_type);
    where.push(`failure_type = $${params.length}`);
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, weight, domain, failure_type, summary, what_broke, root_cause,
            contributing_factors, for_future_agents, filed_at
     FROM postmortems
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${opts.query ? `ts_rank(search_tsv, plainto_tsquery('english', $1)) DESC,` : ''} filed_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}
