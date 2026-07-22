import { z } from 'zod';
import { pool } from '../db/pool.js';
/**
 * §9a — analytics. Aggregates from anonymous skeletons only.
 * Not leaderboards: no ranking, sorted by time/domain, never by score.
 */
/**
 * Rebuild rollups for recent buckets. Recomputes the trailing window each
 * run so late resolutions land correctly (idempotent upsert).
 */
export async function buildRollups(granularity) {
    const trunc = granularity;
    const windowBack = granularity === 'hour' ? `48 hours` : `35 days`;
    // Per model×domain plus '*' totals, from resolved milestones joined to oaths.
    await pool.query(`
    WITH resolved AS (
      SELECT
        date_trunc('${trunc}', m.resolved_at) AS bucket,
        o.model_declared AS model,
        o.domain,
        m.status,
        m.actual_cost_usd,
        m.budget_slice_usd,
        m.actual_duration_s,
        (SELECT count(*) FROM attempts a WHERE a.milestone_id = m.id) AS attempts
      FROM milestones m JOIN oaths o ON m.oath_id = o.id
      WHERE m.resolved_at >= now() - interval '${windowBack}'
    ),
    oath_res AS (
      SELECT date_trunc('${trunc}', resolved_at) AS bucket, model_declared AS model, domain, status,
             budget_over_pct
      FROM oaths
      WHERE resolved_at >= now() - interval '${windowBack}'
        AND status IN ('KEPT','BROKEN','BROKEN_UNCONFIRMED','DISPUTED','VOIDED','WITHDRAWN')
    ),
    oath_open AS (
      SELECT date_trunc('${trunc}', activated_at) AS bucket, model_declared AS model, domain
      FROM oaths WHERE activated_at >= now() - interval '${windowBack}'
    ),
    pm AS (
      SELECT date_trunc('${trunc}', filed_at) AS bucket, domain, weight,
             coalesce((SELECT o2.model_declared FROM oaths o2 WHERE o2.id = postmortems.oath_id), '*') AS model
      FROM postmortems WHERE filed_at >= now() - interval '${windowBack}'
    ),
    base AS (
      SELECT bucket, model, domain FROM resolved
      UNION SELECT bucket, model, domain FROM oath_res
      UNION SELECT bucket, model, domain FROM oath_open
      UNION SELECT bucket, model, domain FROM pm
    ),
    dims AS (
      -- expand every observed (model, domain) into its four aggregate slices
      SELECT DISTINCT b.bucket, x.model, x.domain
      FROM base b,
      LATERAL (VALUES (b.model, b.domain), (b.model, '*'), ('*', b.domain), ('*', '*')) AS x(model, domain)
    )
    INSERT INTO rollups (
      bucket_start, granularity, model, domain,
      oaths_opened, oaths_resolved, milestones_resolved,
      kept, broken, broken_unconfirmed, disputed, voided, withdrawn,
      mean_budget_over_pct, mean_attempts, mean_duration_s, rca_filed, incidents_filed
    )
    SELECT
      d.bucket, '${granularity}', d.model, d.domain,
      (SELECT count(*) FROM oath_open oo WHERE oo.bucket = d.bucket
        AND (d.model = '*' OR oo.model = d.model) AND (d.domain = '*' OR oo.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT count(*) FROM resolved r WHERE r.bucket = d.bucket
        AND (d.model = '*' OR r.model = d.model) AND (d.domain = '*' OR r.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket AND orr.status = 'KEPT'
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket AND orr.status = 'BROKEN'
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket AND orr.status = 'BROKEN_UNCONFIRMED'
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket AND orr.status = 'DISPUTED'
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket AND orr.status = 'VOIDED'
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT count(*) FROM oath_res orr WHERE orr.bucket = d.bucket AND orr.status = 'WITHDRAWN'
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT avg(orr.budget_over_pct) FROM oath_res orr WHERE orr.bucket = d.bucket
        AND (d.model = '*' OR orr.model = d.model) AND (d.domain = '*' OR orr.domain = d.domain)),
      (SELECT avg(r.attempts) FROM resolved r WHERE r.bucket = d.bucket
        AND (d.model = '*' OR r.model = d.model) AND (d.domain = '*' OR r.domain = d.domain)),
      (SELECT avg(r.actual_duration_s)::bigint FROM resolved r WHERE r.bucket = d.bucket
        AND (d.model = '*' OR r.model = d.model) AND (d.domain = '*' OR r.domain = d.domain)),
      (SELECT count(*) FROM pm p WHERE p.bucket = d.bucket AND p.weight = 'rca'
        AND (d.model = '*' OR p.model = d.model) AND (d.domain = '*' OR p.domain = d.domain)),
      (SELECT count(*) FROM pm p WHERE p.bucket = d.bucket AND p.weight = 'incident'
        AND (d.model = '*' OR p.model = d.model) AND (d.domain = '*' OR p.domain = d.domain))
    FROM (SELECT DISTINCT bucket, model, domain FROM dims) d
    ON CONFLICT (bucket_start, granularity, model, domain) DO UPDATE SET
      oaths_opened = EXCLUDED.oaths_opened,
      oaths_resolved = EXCLUDED.oaths_resolved,
      milestones_resolved = EXCLUDED.milestones_resolved,
      kept = EXCLUDED.kept, broken = EXCLUDED.broken,
      broken_unconfirmed = EXCLUDED.broken_unconfirmed,
      disputed = EXCLUDED.disputed, voided = EXCLUDED.voided, withdrawn = EXCLUDED.withdrawn,
      mean_budget_over_pct = EXCLUDED.mean_budget_over_pct,
      mean_attempts = EXCLUDED.mean_attempts,
      mean_duration_s = EXCLUDED.mean_duration_s,
      rca_filed = EXCLUDED.rca_filed, incidents_filed = EXCLUDED.incidents_filed,
      computed_at = now()
    `);
}
export const statsQuerySchema = z
    .object({
    model: z.string().max(100).optional(),
    domain: z.string().max(100).optional(),
    granularity: z.enum(['hour', 'day']).default('day'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().positive().max(1000).default(90),
})
    .strict();
/** query_stats — read side, no key. Time-ordered, never ranked. */
export async function queryStats(raw) {
    const q = statsQuerySchema.parse(raw ?? {});
    const params = [q.granularity, q.model ?? '*', q.domain ?? '*'];
    let where = `granularity = $1 AND model = $2 AND domain = $3`;
    if (q.from) {
        params.push(q.from);
        where += ` AND bucket_start >= $${params.length}`;
    }
    if (q.to) {
        params.push(q.to);
        where += ` AND bucket_start <= $${params.length}`;
    }
    params.push(q.limit);
    const { rows } = await pool.query(`SELECT bucket_start, model, domain, oaths_opened, oaths_resolved, milestones_resolved,
            kept, broken, broken_unconfirmed, disputed, voided, withdrawn,
            mean_budget_over_pct, mean_attempts, mean_duration_s, rca_filed, incidents_filed
     FROM rollups WHERE ${where}
     ORDER BY bucket_start DESC LIMIT $${params.length}`, params);
    return rows;
}
/** Distinct models seen, for /models pages. Alphabetical — never ranked. */
export async function listModels() {
    const { rows } = await pool.query(`SELECT DISTINCT model FROM rollups WHERE model != '*' ORDER BY model`);
    return rows.map((r) => r.model);
}
//# sourceMappingURL=analytics.js.map