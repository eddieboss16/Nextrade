// Production Postgres connection factory — the only place that touches `pg`
// directly. Kept deliberately thin: the persistence/bootstrap logic depends on
// the `Db`/`Queryable` shapes, not on `pg` itself, so it stays testable against
// an in-process pglite instance.

import { Pool, type PoolConfig } from 'pg';
import { withTransaction, type Db } from './persistence';

/**
 * Create a `Db` backed by a pooled Postgres connection. With no argument, `pg`
 * reads the standard PG* environment variables (PGHOST, PGPORT, PGUSER,
 * PGPASSWORD, PGDATABASE).
 *
 * `transaction` acquires a dedicated client from the pool so BEGIN/COMMIT/
 * ROLLBACK all run on the same connection, then releases it — this is why a
 * bare `pool.query` is never used for transactional work.
 */
export function createDb(config?: PoolConfig): Db {
  const pool = new Pool(config);
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await withTransaction(client, fn);
      } finally {
        client.release();
      }
    },
  };
}
