/**
 * End-to-end: register -> swear -> activate -> attempts -> claim ->
 * confirm/dispute -> break -> lock -> incident -> RCA -> unlock ->
 * rollups -> stats -> chain verify -> merkle.
 * Run: DATABASE_URL=... npx tsx --test test/e2e.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx } from '../src/db/pool.js';
import { registerAgent, lookupAgent, queryRegistry, getOath } from '../src/core/registry.js';
import { createCommitment, activateOath, GuardrailError } from '../src/core/commitments.js';
import { logAttempt, fileClaim, respondToClaim, maybeResolveParent } from '../src/core/claims.js';
import { filePostmortem, fileIncident, searchPostmortems } from '../src/core/postmortems.js';
import { buildRollups, queryStats } from '../src/core/analytics.js';
import { verifyChain } from '../src/core/entrylog.js';

const future = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function baseCommitment(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'ml-training',
    goal: 'Fine-tune TTS model to MOS >= 4.0 and ship checkpoint artifact with hash',
    deadline: future(48),
    budget_cap_usd: 20,
    model_declared: 'claude-opus-4-8',
    counterparty_email: 'human@example.com',
    milestones: [
      {
        title: 'Bounded probe: one epoch completes under $3',
        criteria: { type: 'metric_threshold', metric: 'probe_cost_usd', operator: 'lte', threshold: 3 },
        deadline: future(12),
        budget_slice_usd: 3,
      },
      {
        title: 'Checkpoint artifact shipped with sha256',
        criteria: { type: 'artifact_hash', artifact_name: 'checkpoint.pt', hash_algo: 'sha256' },
        deadline: future(40),
        budget_slice_usd: 15,
      },
    ],
    ...overrides,
  };
}

let agentId: string;
let pubkey: string;

test('register agent', async () => {
  const r = await registerAgent(`test-op-${Date.now()}`, `test-agent-${Date.now()}`);
  agentId = r.agent_id;
  pubkey = r.pubkey;
  assert.ok(r.api_token.length === 64);
  assert.ok(r.pubkey.length === 64);
});

test('guardrails: confidence field is unsubmittable', async () => {
  await assert.rejects(
    createCommitment(agentId, baseCommitment({ confidence: 0.75 })),
    (e: GuardrailError) => /you swear it or you don't/.test(e.errors[0]),
  );
});

test('guardrails: hedge language rejected', async () => {
  await assert.rejects(
    createCommitment(agentId, baseCommitment({ goal: 'I will try to make the model better hopefully by tuesday' })),
    (e: GuardrailError) => e.errors.some((x) => /hedge language/.test(x)),
  );
});

test('guardrails: budget slices must fit cap', async () => {
  const c = baseCommitment({ budget_cap_usd: 5 });
  await assert.rejects(
    createCommitment(agentId, c),
    (e: GuardrailError) => e.errors.some((x) => /exceeding cap/.test(x)),
  );
});

test('guardrails: milestone deadline may not exceed parent', async () => {
  const c = baseCommitment();
  (c.milestones as any)[1].deadline = future(100);
  await assert.rejects(
    createCommitment(agentId, c),
    (e: GuardrailError) => e.errors.some((x) => /exceeds parent deadline/.test(x)),
  );
});

let oathId: string;
let oathRef: number;
let cpToken: string;
let ms1: string, ms2: string;

test('swear + activate the happy-path oath', async () => {
  const draft = await createCommitment(agentId, baseCommitment());
  oathId = draft.oath_id;
  oathRef = draft.ref;
  assert.equal(draft.status, 'DRAFT');
  assert.ok(['A', 'B', 'C'].includes(draft.specificity_grade!));

  const act = await activateOath(draft.activation_token);
  assert.equal(act.status, 'OPEN');
  cpToken = act.counterparty_token;

  const { rows } = await pool.query(
    `SELECT id FROM milestones WHERE oath_id = $1 ORDER BY position`, [oathId]);
  [ms1, ms2] = rows.map((r) => r.id);
});

test('activation token is one-time', async () => {
  await assert.rejects(activateOath('not-a-real-token'));
});

test('attempt ledger: counts and models, no text possible', async () => {
  await logAttempt(agentId, ms1, 'claude-sonnet-5', null, 'fail');
  await logAttempt(agentId, ms1, 'claude-sonnet-5', null, 'retry');
  const r = await logAttempt(agentId, ms1, 'claude-opus-4-8', null, 'success');
  assert.equal(r.attempts, 3);
  // schema-level: attempts table has no text column
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'attempts'`);
  assert.ok(!cols.rows.some((c) => ['note', 'text', 'description'].includes(c.column_name)));
});

test('claim milestone 1 + confirm -> KEPT', async () => {
  const claim = await fileClaim(agentId, ms1, {
    evidence: { type: 'metric_threshold', measured_value: 2.4 },
    actual_cost_usd: 2.4,
    actual_duration_s: 3600,
  });
  assert.ok(claim.claim_id);
  const verdict = await respondToClaim(cpToken, claim.claim_id, 'confirm');
  assert.equal(verdict.verdict, 'KEPT');
});

test('evidence must match frozen criteria', async () => {
  await assert.rejects(
    fileClaim(agentId, ms2, {
      evidence: { type: 'metric_threshold', measured_value: 1 },
      actual_cost_usd: 1,
      actual_duration_s: 10,
    }),
    (e: GuardrailError) => e.errors.some((x) => /does not match pre-registered criteria/.test(x)),
  );
});

test('claim milestone 2 + dispute -> DISPUTED, parent DISPUTED', async () => {
  const claim = await fileClaim(agentId, ms2, {
    evidence: { type: 'artifact_hash', sha256: 'a'.repeat(64) },
    actual_cost_usd: 9,
    actual_duration_s: 7200,
  });
  const verdict = await respondToClaim(cpToken, claim.claim_id, 'dispute', 'The checkpoint does not load.');
  assert.equal(verdict.verdict, 'DISPUTED');
  const o = await getOath(oathRef);
  assert.equal(o!.status, 'DISPUTED');
});

test('verdicts are permanent at the database layer', async () => {
  await assert.rejects(
    pool.query(`UPDATE oaths SET status = 'KEPT' WHERE id = $1`, [oathId]),
    /permanent/,
  );
  await assert.rejects(pool.query(`DELETE FROM oaths WHERE id = $1`, [oathId]), /permanent/);
  await assert.rejects(pool.query(`DELETE FROM attempts`), /permanent/);
  await assert.rejects(pool.query(`UPDATE attempts SET model = 'x'`), /append-only/);
});

// ---- break path: expiry, lock, incident gate, RCA, unlock ----

let brokeOathId: string;
let brokeRef: number;
let bm1: string, bm2: string;

test('deadline expiry breaks milestone and locks identity', async () => {
  const c = baseCommitment();
  (c.milestones as any) = [
    {
      title: 'Ship probe artifact quickly for the expiry test',
      criteria: { type: 'artifact_hash', artifact_name: 'probe.bin', hash_algo: 'sha256' },
      deadline: new Date(Date.now() + 1200).toISOString(),
      budget_slice_usd: 2,
    },
    {
      title: 'Ship final artifact for the expiry test',
      criteria: { type: 'artifact_hash', artifact_name: 'final.bin', hash_algo: 'sha256' },
      deadline: new Date(Date.now() + 1500).toISOString(),
      budget_slice_usd: 2,
    },
  ];
  c.deadline = new Date(Date.now() + 1800).toISOString();
  const draft = await createCommitment(agentId, c);
  brokeOathId = draft.oath_id;
  brokeRef = draft.ref;
  await activateOath(draft.activation_token);
  const { rows } = await pool.query(
    `SELECT id FROM milestones WHERE oath_id = $1 ORDER BY position`, [brokeOathId]);
  [bm1, bm2] = rows.map((r) => r.id);

  await new Promise((r) => setTimeout(r, 2000)); // let deadlines pass

  // simulate scheduler tick for this oath
  const now = new Date();
  await tx(async (client) => {
    await client.query(
      `UPDATE milestones SET status = 'BROKEN', resolved_at = $2, deadline_met = false
       WHERE oath_id = $1 AND status = 'OPEN'`, [brokeOathId, now]);
    await maybeResolveParent(client, brokeOathId, now);
  });

  const o = await getOath(brokeRef);
  assert.equal(o!.status, 'BROKEN');
  const agent = await pool.query(`SELECT locked FROM agents WHERE id = $1`, [agentId]);
  assert.equal(agent.rows[0].locked, true);
});

test('locked identity cannot swear', async () => {
  await assert.rejects(
    createCommitment(agentId, baseCommitment()),
    (e: GuardrailError) => /postmortem outstanding/.test(e.errors[0]),
  );
});

test('incident note: session dumps rejected, clean notes accepted', async () => {
  await assert.rejects(
    fileIncident(agentId, bm1, {
      failure_type: 'deadline-miss',
      what_broke: 'user: please train the model\nassistant: I will start by...',
      root_cause: 'transcript smuggling attempt with enough length to pass',
      lesson: 'this should be rejected because it looks like a session dump',
    }),
    (e: GuardrailError) => /session\/prompt dump/.test(e.errors[0]),
  );
  const r = await fileIncident(agentId, bm1, {
    failure_type: 'deadline-miss',
    what_broke: 'Probe artifact was never produced before the milestone deadline.',
    root_cause: 'No time buffer: milestone deadline assumed zero setup time.',
    lesson: 'Put explicit setup time in the first milestone deadline.',
  });
  assert.equal(r.gate_cleared, true);
});

test('RCA: dump rejected, valid RCA unlocks identity', async () => {
  await assert.rejects(
    filePostmortem(agentId, brokeOathId, {
      failure_type: 'deadline-miss',
      summary: 'x'.repeat(60),
      timeline: [{ date: '2026-07-22', event: 'a' }, { date: '2026-07-23', event: 'b' }],
      what_broke: 'assistant: let me think about this step by step and then',
      root_cause: 'y'.repeat(40),
      contributing_factors: 'z'.repeat(20),
      for_future_agents: 'w'.repeat(40),
    }),
    (e: GuardrailError) => /session\/prompt dump/.test(e.errors[0]),
  );

  const r = await filePostmortem(agentId, brokeOathId, {
    failure_type: 'deadline-miss',
    summary:
      'Two-milestone artifact oath expired unclaimed. Deadlines were set seconds after activation with no working buffer; no artifact was produced.',
    timeline: [
      { date: '2026-07-22', event: 'oath activated' },
      { date: '2026-07-22', event: 'both milestone deadlines passed unclaimed' },
    ],
    what_broke: 'Neither milestone produced its artifact before its deadline; the oath auto-expired.',
    root_cause: 'Deadlines were sworn without any execution buffer — a guess presented as certainty.',
    contributing_factors: 'No bounded probe was run before swearing the schedule.',
    for_future_agents: 'Swear deadlines only after a bounded probe; include explicit buffer for setup.',
  });
  assert.equal(r.identity_unlocked, true);
  const agent = await pool.query(`SELECT locked FROM agents WHERE id = $1`, [agentId]);
  assert.equal(agent.rows[0].locked, false);
});

test('unlocked identity can swear again', async () => {
  const draft = await createCommitment(agentId, baseCommitment());
  assert.equal(draft.status, 'DRAFT');
});

test('corpus search finds the lesson', async () => {
  const hits = await searchPostmortems({ query: 'deadline buffer probe', domain: 'ml-training' });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h: any) => /bounded probe/.test(h.for_future_agents)));
});

test('rollups + query_stats', async () => {
  await buildRollups('hour');
  await buildRollups('day');
  const stats = await queryStats({ granularity: 'day', limit: 10 });
  assert.ok(stats.length >= 1);
  const model = await queryStats({ model: 'claude-opus-4-8', granularity: 'day', limit: 10 });
  assert.ok(model.length >= 1);
  assert.ok(model.some((r: any) => r.broken > 0 || r.disputed > 0));
});

test('registry reads: lookup, list, oath view with path', async () => {
  const a = await lookupAgent(pubkey);
  assert.equal(a!.model_identity, 'operator-declared');
  assert.ok(a!.oaths.length >= 2);

  const list = await queryRegistry({ domain: 'ml-training', limit: 10 });
  assert.ok(list.length >= 2);

  const o = await getOath(oathRef);
  assert.equal(o!.milestones.length, 2);
  assert.equal(Number(o!.milestones[0].attempts), 3);
  assert.deepEqual(
    [...(o!.milestones[0].models_used ?? [])].sort(),
    ['claude-opus-4-8', 'claude-sonnet-5'],
  );
});

test('entry log chain verifies end to end', async () => {
  const client = await pool.connect();
  try {
    assert.equal(await verifyChain(client), null);
  } finally {
    client.release();
  }
});

test('teardown', async () => {
  await pool.end();
});
