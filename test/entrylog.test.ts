import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { logEvent } from '../src/core/entrylog.js';
import { sha256Hex } from '../src/core/crypto.js';

test('logEvent takes the transaction advisory lock before reading the tail', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes('SELECT this_hash')) return { rows: [] };
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;

  await logEvent(client, 'test.event', { ref: 1 });

  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(calls[1].sql, /SELECT this_hash/);
  assert.match(calls[2].sql, /INSERT INTO entry_log/);
  assert.equal(calls[2].params?.[2], sha256Hex('HORKOS-GENESIS'));
});
