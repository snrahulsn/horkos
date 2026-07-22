import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

export const pool = new pg.Pool({
  connectionString,
  max: 5, // free-tier friendly
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? undefined
    : { rejectUnauthorized: false },
});

/** Run fn inside a transaction. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
