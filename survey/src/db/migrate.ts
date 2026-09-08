/**
 * Apply `migrations/*.sql` in name order, once each, as the database owner.
 *
 *   npm run migrate        (after `npm run build`; used by deploy/deploy.sh)
 *   npm run migrate:dev    (straight from TypeScript)
 *
 * Each file runs inside one transaction and is recorded in
 * `public.schema_migrations`. An advisory lock keeps two deploys from racing.
 * A failure leaves the database as it was — deploy.sh stops before restarting
 * the service, so the old process keeps serving.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { loadEnv } from '../env.js';

const LOCK_KEY = 7_260_817; // arbitrary, stable

export async function migrate(connectionString: string, dir = 'migrations'): Promise<string[]> {
  const client = new pg.Client({ connectionString, application_name: 'ascend-survey:migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(resolve(dir))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(resolve(dir), f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  } finally {
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const env = loadEnv();
  if (!env.MIGRATE_DATABASE_URL) {
    console.error('MIGRATE_DATABASE_URL is not set (the database owner connection used only for migrations).');
    process.exit(1);
  }
  migrate(env.MIGRATE_DATABASE_URL)
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations');
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
