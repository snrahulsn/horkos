import { test } from 'node:test';
import assert from 'node:assert/strict';

test('public registry strips hash-only records to the non-identifying skeleton', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
  const { pool } = await import('../src/db/pool.js');
  const { queryRegistry } = await import('../src/core/registry.js');
  const originalQuery = pool.query.bind(pool);
  let sql = '';
  (pool as any).query = async (query: string) => {
    sql = query;
    return {
      rows: [{
        ref: 7,
        status: 'OPEN',
        visibility: 'hash_only',
        commitment_hash: 'a'.repeat(64),
        activated_at: new Date('2026-01-01T00:00:00Z'),
        resolved_at: null,
        total_count: 1,
        task_title: 'Secret internal task',
        domain: 'secret-domain',
        model_declared: 'secret-model',
        goal: 'secret goal',
        agent_pubkey: 'secret-key',
      }],
    };
  };

  try {
    const rows = await queryRegistry({ limit: 1 });
    assert.match(sql, /o\.visibility != 'private'/);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'activated_at', 'commitment_hash', 'ref', 'resolved_at', 'status', 'total_count', 'visibility',
    ]);
  } finally {
    (pool as any).query = originalQuery;
  }
});
