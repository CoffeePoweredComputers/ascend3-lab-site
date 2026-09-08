/**
 * Two connection pools, two database roles.
 *
 * `survey` (role survey_app) sees only the `survey` schema — coded responses.
 * `keyring` (role keyring_app) sees only the `keyring` schema — the PID↔code
 * key and rosters. Keeping them on separate connections is what makes the
 * protocol's "the application cannot read the key back joined to responses"
 * a property of the system rather than a coding convention.
 */
import pg from 'pg';
import type { Env } from '../env.js';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export interface Pools {
  survey: Pool;
  keyring: Pool;
}

function makePool(connectionString: string, name: string): Pool {
  return new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: `ascend-survey:${name}`,
    statement_timeout: 15_000,
  });
}

export function createPools(env: Env): Pools {
  return {
    survey: makePool(env.SURVEY_DATABASE_URL, 'survey'),
    keyring: makePool(env.KEYRING_DATABASE_URL, 'keyring'),
  };
}

export async function withTx<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function pingPools(pools: Pools): Promise<{ survey: boolean; keyring: boolean }> {
  const ping = async (p: Pool) => {
    try {
      await p.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };
  return { survey: await ping(pools.survey), keyring: await ping(pools.keyring) };
}

export async function closePools(pools: Pools): Promise<void> {
  await Promise.allSettled([pools.survey.end(), pools.keyring.end()]);
}

/** Postgres unique_violation. */
export function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505';
}
