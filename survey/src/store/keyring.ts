/**
 * The identity side. Everything here runs on the `keyring` pool (role
 * keyring_app), which cannot see the `survey` schema. The only thing that
 * crosses the boundary is the participant CODE, carried by the application
 * from a keyring lookup into survey-side queries — never the reverse.
 */
import { isUniqueViolation, withTx, type Client, type Pool } from '../db/pools.js';

export interface Enrollment {
  code: string;
  ferpaGranted: boolean;
  enrolledAt: string;
}

export async function findEnrollment(pool: Pool, surveyId: string, pid: string): Promise<Enrollment | null> {
  const { rows } = await pool.query<{ code: string; ferpa_granted: boolean; enrolled_at: Date }>(
    'SELECT code, ferpa_granted, enrolled_at FROM keyring.enrollments WHERE survey_id = $1 AND pid = $2',
    [surveyId, pid],
  );
  const r = rows[0];
  return r ? { code: r.code, ferpaGranted: r.ferpa_granted, enrolledAt: r.enrolled_at.toISOString() } : null;
}

export async function onRoster(pool: Pool, surveyId: string, pid: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM keyring.rosters WHERE survey_id = $1 AND pid = $2', [surveyId, pid]);
  return (rowCount ?? 0) > 0;
}

export async function rosterSize(pool: Pool, surveyId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM keyring.rosters WHERE survey_id = $1', [surveyId]);
  return Number(rows[0]?.n ?? 0);
}

export async function listRoster(pool: Pool, surveyId: string): Promise<string[]> {
  const { rows } = await pool.query<{ pid: string }>('SELECT pid FROM keyring.rosters WHERE survey_id = $1 ORDER BY pid', [surveyId]);
  return rows.map((r) => r.pid);
}

export async function replaceRoster(pool: Pool, surveyId: string, pids: string[], actorPid: string): Promise<number> {
  const unique = [...new Set(pids.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  return withTx(pool, async (c) => {
    await c.query('DELETE FROM keyring.rosters WHERE survey_id = $1', [surveyId]);
    if (unique.length) {
      await c.query('INSERT INTO keyring.rosters (survey_id, pid) SELECT $1, unnest($2::text[])', [surveyId, unique]);
    }
    await c.query('INSERT INTO keyring.key_events (survey_id, event, actor_pid, row_count) VALUES ($1, $2, $3, $4)', [
      surveyId,
      'roster_replace',
      actorPid,
      unique.length,
    ]);
    return unique.length;
  });
}

export interface NewEnrollment {
  surveyId: string;
  pid: string;
  code: string;
  ferpaGranted: boolean;
  ferpaName: string | null;
  ferpaDate: string | null;
}

/**
 * Run `fn` while holding a per-(survey, pid) advisory lock, so two consent
 * submissions from the same person cannot both enrol. `fn` receives the
 * keyring client and must insert the enrollment through `insertEnrollment`.
 */
export async function withEnrollmentLock<T>(pool: Pool, surveyId: string, pid: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${surveyId} ${pid}`]);
    return fn(c);
  });
}

/** Returns false if this pid is already enrolled (unique violation). */
export async function insertEnrollment(c: Client, e: NewEnrollment): Promise<boolean> {
  try {
    await c.query('SAVEPOINT enrol');
    await c.query(
      `INSERT INTO keyring.enrollments (survey_id, pid, code, ferpa_granted, ferpa_name, ferpa_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.surveyId, e.pid, e.code, e.ferpaGranted, e.ferpaName, e.ferpaDate],
    );
    await c.query('RELEASE SAVEPOINT enrol');
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await c.query('ROLLBACK TO SAVEPOINT enrol');
      return false;
    }
    throw err;
  }
}

export interface EnrollmentExportRow {
  code: string;
  pid: string;
  email: string;
  enrolled_at: string;
  ferpa_granted: boolean;
  ferpa_name: string | null;
  ferpa_date: string | null;
}

export async function exportEnrollments(pool: Pool, surveyId: string, actorPid: string): Promise<EnrollmentExportRow[]> {
  return withTx(pool, async (c) => {
    const { rows } = await c.query<{
      code: string;
      pid: string;
      enrolled_at: Date;
      ferpa_granted: boolean;
      ferpa_name: string | null;
      ferpa_date: Date | null;
    }>(
      'SELECT code, pid, enrolled_at, ferpa_granted, ferpa_name, ferpa_date FROM keyring.enrollments WHERE survey_id = $1 ORDER BY enrolled_at',
      [surveyId],
    );
    await c.query('INSERT INTO keyring.key_events (survey_id, event, actor_pid, row_count) VALUES ($1, $2, $3, $4)', [
      surveyId,
      'export',
      actorPid,
      rows.length,
    ]);
    return rows.map((r) => ({
      code: r.code,
      pid: r.pid,
      email: `${r.pid}@vt.edu`,
      enrolled_at: r.enrolled_at.toISOString(),
      ferpa_granted: r.ferpa_granted,
      ferpa_name: r.ferpa_name,
      ferpa_date: r.ferpa_date ? r.ferpa_date.toISOString().slice(0, 10) : null,
    }));
  });
}

export async function enrollmentCount(pool: Pool, surveyId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM keyring.enrollments WHERE survey_id = $1', [surveyId]);
  return Number(rows[0]?.n ?? 0);
}

export async function destroyKey(pool: Pool, surveyId: string, actorPid: string): Promise<{ enrollments: number; rosters: number }> {
  return withTx(pool, async (c) => {
    const e = await c.query('DELETE FROM keyring.enrollments WHERE survey_id = $1', [surveyId]);
    const r = await c.query('DELETE FROM keyring.rosters WHERE survey_id = $1', [surveyId]);
    await c.query('INSERT INTO keyring.key_events (survey_id, event, actor_pid, row_count) VALUES ($1, $2, $3, $4)', [
      surveyId,
      'destroy',
      actorPid,
      e.rowCount ?? 0,
    ]);
    return { enrollments: e.rowCount ?? 0, rosters: r.rowCount ?? 0 };
  });
}

export interface KeyEvent {
  event: string;
  actorPid: string;
  rowCount: number | null;
  at: string;
}

export async function keyEvents(pool: Pool, surveyId: string): Promise<KeyEvent[]> {
  const { rows } = await pool.query<{ event: string; actor_pid: string; row_count: number | null; created_at: Date }>(
    'SELECT event::text, actor_pid, row_count, created_at FROM keyring.key_events WHERE survey_id = $1 ORDER BY created_at DESC LIMIT 50',
    [surveyId],
  );
  return rows.map((r) => ({ event: r.event, actorPid: r.actor_pid, rowCount: r.row_count, at: r.created_at.toISOString() }));
}
