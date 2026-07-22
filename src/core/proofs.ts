import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canonicalJson, sha256Hex } from './crypto.js';

export type ProofStatus = 'verified' | 'rejected';

const proofInputSchema = z
  .object({
    oath_id: z.string().uuid().optional(),
    milestone_id: z.string().uuid().optional(),
    kind: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    source: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    external_id: z.string().min(1).max(500),
    assertion: z.unknown().refine((value) => value !== undefined, 'assertion is required'),
    observed_at: z.string().datetime({ offset: true }),
    adapter_version: z.string().min(1).max(100),
  })
  .strict()
  .refine((value) => value.oath_id || value.milestone_id, {
    message: 'oath_id or milestone_id is required',
  });

export type ProofInput = z.infer<typeof proofInputSchema>;

let ingestorPool: pg.Pool | undefined;

function getIngestorPool(): pg.Pool {
  const connectionString = process.env.PROOF_DATABASE_URL;
  if (!connectionString) {
    throw new Error('PROOF_DATABASE_URL is not set (must authenticate as horkos_proof_ingestor)');
  }
  if (!ingestorPool) {
    ingestorPool = new pg.Pool({
      connectionString,
      max: 2,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? undefined
        : { rejectUnauthorized: false },
    });
  }
  return ingestorPool;
}

export async function verifyProofIngestorConnection(): Promise<void> {
  const { rows } = await getIngestorPool().query(`SELECT session_user AS role`);
  if (rows[0]?.role !== 'horkos_proof_ingestor') {
    throw new Error('PROOF_DATABASE_URL must authenticate as horkos_proof_ingestor');
  }
}

function requireIngestSecret(candidate: string): void {
  const expected = process.env.PROOF_INGEST_SECRET;
  if (!expected) throw new Error('PROOF_INGEST_SECRET is not set');
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('invalid proof ingest secret');
  }
}

function proofDigest(input: ProofInput): string {
  return sha256Hex(canonicalJson({
    oath_id: input.oath_id ?? null,
    milestone_id: input.milestone_id ?? null,
    kind: input.kind,
    source: input.source,
    external_id: input.external_id,
    assertion: input.assertion,
    observed_at: new Date(input.observed_at).toISOString(),
  }));
}

async function recordAdapterResult(secret: string, raw: unknown, status: ProofStatus) {
  requireIngestSecret(secret);
  const input = proofInputSchema.parse(raw);
  const observedAt = new Date(input.observed_at).toISOString();
  const digest = proofDigest(input);
  const db = getIngestorPool();

  const inserted = await db.query(
    `INSERT INTO proofs (
       oath_id, milestone_id, kind, source, external_id, assertion,
       observed_at, digest, status, adapter_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING *`,
    [
      input.oath_id ?? null, input.milestone_id ?? null, input.kind, input.source,
      input.external_id, JSON.stringify(input.assertion), observedAt, digest, status,
      input.adapter_version,
    ],
  );
  if (inserted.rows.length) return inserted.rows[0];

  // Adapter delivery is at-least-once. Identical replays are idempotent;
  // reusing an external identifier for different evidence is an error.
  const existing = await db.query(
    `SELECT * FROM proofs WHERE source = $1 AND external_id = $2`,
    [input.source, input.external_id],
  );
  const row = existing.rows[0];
  if (!row || row.digest !== digest || row.status !== status ||
      row.oath_id !== (input.oath_id ?? row.oath_id) ||
      row.milestone_id !== (input.milestone_id ?? row.milestone_id)) {
    throw new Error(`proof identity collision: ${input.source}/${input.external_id}`);
  }
  return row;
}

/** Called only by a trusted adapter after independently verifying its source. */
export function recordVerifiedAssertion(ingestSecret: string, input: unknown) {
  return recordAdapterResult(ingestSecret, input, 'verified');
}

/** Preserve a failed verification without allowing it into verified analytics. */
export function recordRejectedAssertion(ingestSecret: string, input: unknown) {
  return recordAdapterResult(ingestSecret, input, 'rejected');
}

const coverageQuerySchema = z
  .object({
    oath_id: z.string().uuid().optional(),
    milestone_id: z.string().uuid().optional(),
    required_kinds: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/)).max(50).default([]),
  })
  .strict()
  .refine((value) => value.oath_id || value.milestone_id, {
    message: 'oath_id or milestone_id is required',
  });

/** Read-side coverage only. Consumers must require status=verified themselves. */
export async function queryProofCoverage(raw: unknown) {
  const query = coverageQuerySchema.parse(raw);
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.oath_id) {
    params.push(query.oath_id);
    where.push(`oath_id = $${params.length}`);
  }
  if (query.milestone_id) {
    params.push(query.milestone_id);
    where.push(`milestone_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT kind, source, status, count(*)::int AS count,
            max(observed_at) AS last_observed_at
     FROM proofs WHERE ${where.join(' AND ')}
     GROUP BY kind, source, status
     ORDER BY kind, source, status`,
    params,
  );

  const verifiedKinds = new Set(
    rows.filter((row) => row.status === 'verified').map((row) => row.kind),
  );
  return {
    proofs: rows,
    required: query.required_kinds.map((kind) => ({ kind, verified: verifiedKinds.has(kind) })),
    complete: query.required_kinds.every((kind) => verifiedKinds.has(kind)),
  };
}
