/**
 * The coded side. Everything here runs on the `survey` pool (role survey_app),
 * which cannot see the `keyring` schema. Participants exist here only as codes.
 */
import type { ConfigRegistry } from '../config/load.js';
import { isUniqueViolation, type Pool } from '../db/pools.js';
import { generateCode } from '../engine/session.js';

/** Record every current config version (idempotent) and load historical ones into the registry. */
export async function snapshotConfigs(pool: Pool, registry: ConfigRegistry): Promise<{ inserted: number; historical: number }> {
  let inserted = 0;
  for (const s of registry.list()) {
    const r = await pool.query(
      'INSERT INTO survey.survey_configs (survey_id, config_version, config) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [s.config.id, s.version, JSON.stringify(s.raw)],
    );
    inserted += r.rowCount ?? 0;
  }
  const { rows } = await pool.query<{ survey_id: string; config_version: string; config: unknown }>(
    'SELECT survey_id, config_version, config FROM survey.survey_configs',
  );
  let historical = 0;
  for (const r of rows) {
    if (registry.getVersion(r.config_version)) continue;
    registry.addHistorical(r.config, r.config_version, r.survey_id);
    historical++;
  }
  return { inserted, historical };
}

export interface NewParticipant {
  surveyId: string;
  isAdult: boolean;
  ferpaGranted: boolean;
  rosterMatched: boolean | null;
}

/** Insert a participant with a fresh code; retries on the (rare) code collision. */
export async function insertParticipant(pool: Pool, p: NewParticipant): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    try {
      await pool.query(
        'INSERT INTO survey.participants (code, survey_id, is_adult, ferpa_granted, roster_matched) VALUES ($1, $2, $3, $4, $5)',
        [code, p.surveyId, p.isAdult, p.ferpaGranted, p.rosterMatched],
      );
      return code;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error('could not allocate a participant code');
}

/** Self-heal: an enrollment exists but its participant row is missing (keyring insert outlived a failed survey insert). */
export async function ensureParticipant(pool: Pool, code: string, surveyId: string, ferpaGranted: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO survey.participants (code, survey_id, is_adult, ferpa_granted, roster_matched)
     VALUES ($1, $2, true, $3, NULL) ON CONFLICT (code) DO NOTHING`,
    [code, surveyId, ferpaGranted],
  );
}

export interface WaveCounts {
  waveId: string;
  active: number;
  completed: number;
  stopped: number;
  expired: number;
  previews: number;
}

export async function surveyCounts(pool: Pool, surveyId: string): Promise<{ participants: number; waves: WaveCounts[] }> {
  const p = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM survey.participants WHERE survey_id = $1', [surveyId]);
  const w = await pool.query<{ wave_id: string; status: string; is_preview: boolean; n: string }>(
    'SELECT wave_id, status::text, is_preview, count(*)::text AS n FROM survey.sessions WHERE survey_id = $1 GROUP BY 1, 2, 3',
    [surveyId],
  );
  const byWave = new Map<string, WaveCounts>();
  for (const r of w.rows) {
    const c = byWave.get(r.wave_id) ?? { waveId: r.wave_id, active: 0, completed: 0, stopped: 0, expired: 0, previews: 0 };
    const n = Number(r.n);
    if (r.is_preview) c.previews += n;
    else if (r.status === 'active') c.active += n;
    else if (r.status === 'completed') c.completed += n;
    else if (r.status === 'stopped') c.stopped += n;
    else if (r.status === 'expired') c.expired += n;
    byWave.set(r.wave_id, c);
  }
  return { participants: Number(p.rows[0]?.n ?? 0), waves: [...byWave.values()] };
}

/* ── exports (coded data only) ─────────────────────────────────────────────── */

export const SESSION_COLUMNS = [
  'session_id',
  'participant_code',
  'wave_id',
  'status',
  'is_preview',
  'config_version',
  'model',
  'started_at',
  'ended_at',
  'turn_count',
  'starters_answered',
  'probes_asked',
];

export async function exportSessions(pool: Pool, surveyId: string, includePreview: boolean): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.participant_code, s.wave_id, s.status::text, s.is_preview, s.config_version, s.model,
            s.started_at, s.ended_at, s.turn_count,
            (SELECT count(DISTINCT t.starter_index) FROM survey.turns t WHERE t.session_id = s.id AND t.kind = 'answer')::int AS starters_answered,
            (SELECT count(*) FROM survey.turns t WHERE t.session_id = s.id AND t.kind = 'probe')::int AS probes_asked
       FROM survey.sessions s
      WHERE s.survey_id = $1 AND ($2 OR NOT s.is_preview)
      ORDER BY s.started_at`,
    [surveyId, includePreview],
  );
  return rows as Array<Record<string, unknown>>;
}

export const TURN_COLUMNS = [
  'session_id',
  'participant_code',
  'wave_id',
  'is_preview',
  'seq',
  'kind',
  'starter_index',
  'starter_id',
  'probe_index',
  'probe_type',
  'trigger',
  'text',
  'flags',
  'config_version',
  'llm_call_id',
  'created_at',
];

export async function exportTurns(pool: Pool, surveyId: string, includePreview: boolean): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `SELECT t.session_id, s.participant_code, s.wave_id, s.is_preview, t.seq, t.kind::text, t.starter_index, t.starter_id, t.probe_index,
            t.probe_type, t.trigger, t.text, t.flags, t.config_version, t.llm_call_id, t.created_at
       FROM survey.turns t JOIN survey.sessions s ON s.id = t.session_id
      WHERE s.survey_id = $1 AND ($2 OR NOT s.is_preview)
      ORDER BY s.started_at, t.session_id, t.seq`,
    [surveyId, includePreview],
  );
  return rows as Array<Record<string, unknown>>;
}

interface TranscriptExchange {
  role: 'q' | 'a';
  probe_index: number | null;
  probe_type: string | null;
  text: string | null;
  flags?: Record<string, unknown>;
}

interface TranscriptStarter {
  starter_index: number;
  starter_id: string;
  text: string | null;
  exchanges: TranscriptExchange[];
  ended_by: string | null;
}

/** One object per session: starters → exchanges → why each ended. */
export async function exportTranscripts(pool: Pool, surveyId: string, includePreview: boolean): Promise<Array<Record<string, unknown>>> {
  const sessions = await exportSessions(pool, surveyId, includePreview);
  const turns = await exportTurns(pool, surveyId, includePreview);
  const bySession = new Map<string, Array<Record<string, unknown>>>();
  for (const t of turns) {
    const k = String(t.session_id);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(t);
  }
  return sessions.map((s) => {
    const starters: TranscriptStarter[] = [];
    let cur: TranscriptStarter | null = null;
    for (const t of bySession.get(String(s.session_id)) ?? []) {
      const idx = Number(t.starter_index);
      if (!cur || cur.starter_index !== idx) {
        cur = { starter_index: idx, starter_id: String(t.starter_id), text: null, exchanges: [], ended_by: null };
        starters.push(cur);
      }
      const kind = String(t.kind);
      const text = (t.text as string | null) ?? null;
      if (kind === 'starter') cur.text = text;
      else if (kind === 'probe') {
        cur.exchanges.push({
          role: 'q',
          probe_index: t.probe_index as number,
          probe_type: t.probe_type as string,
          text,
          flags: (t.flags as Record<string, unknown>) ?? {},
        });
      } else if (kind === 'answer') cur.exchanges.push({ role: 'a', probe_index: t.probe_index as number, probe_type: null, text });
      else if (kind === 'advance') cur.ended_by = t.trigger as string;
      else if (kind === 'stop') cur.ended_by = 'stopped';
    }
    return {
      session_id: s.session_id,
      participant_code: s.participant_code,
      wave_id: s.wave_id,
      status: s.status,
      is_preview: s.is_preview,
      config_version: s.config_version,
      model: s.model,
      started_at: s.started_at,
      ended_at: s.ended_at,
      starters,
    };
  });
}

/* ── results viewer (coded data only) ──────────────────────────────────────── */

export interface SessionListRow {
  session_id: string;
  participant_code: string | null;
  wave_id: string;
  status: string;
  is_preview: boolean;
  started_at: Date;
  ended_at: Date | null;
  duration_s: number | null;
  turn_count: number;
  starters_answered: number;
  probes_asked: number;
  /** advance trigger → count, e.g. { move_on: 2, skipped: 1 } */
  ended_by: Record<string, number>;
}

export interface ListSessionsOptions {
  waveId?: string;
  status?: string;
  includePreview: boolean;
  limit: number;
  offset: number;
}

export async function listSessions(pool: Pool, surveyId: string, o: ListSessionsOptions): Promise<{ total: number; rows: SessionListRow[] }> {
  const { rows } = await pool.query<SessionListRow & { total: number }>(
    `SELECT s.id AS session_id, s.participant_code, s.wave_id, s.status::text, s.is_preview, s.started_at, s.ended_at,
            EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_activity_at) - s.started_at))::int AS duration_s,
            s.turn_count,
            (SELECT count(DISTINCT t.starter_index) FROM survey.turns t WHERE t.session_id = s.id AND t.kind = 'answer')::int AS starters_answered,
            (SELECT count(*) FROM survey.turns t WHERE t.session_id = s.id AND t.kind = 'probe')::int AS probes_asked,
            COALESCE((SELECT jsonb_object_agg(x.trigger, x.n)
                        FROM (SELECT t.trigger, count(*)::int AS n FROM survey.turns t
                               WHERE t.session_id = s.id AND t.kind = 'advance' GROUP BY t.trigger) x), '{}'::jsonb) AS ended_by,
            count(*) OVER ()::int AS total
       FROM survey.sessions s
      WHERE s.survey_id = $1
        AND ($2::text IS NULL OR s.wave_id = $2)
        AND ($3::text IS NULL OR s.status::text = $3)
        AND ($4 OR NOT s.is_preview)
      ORDER BY s.started_at DESC
      LIMIT $5 OFFSET $6`,
    [surveyId, o.waveId ?? null, o.status ?? null, o.includePreview, o.limit, o.offset],
  );
  const total = rows[0]?.total ?? 0;
  return { total, rows: rows.map(({ total: _t, ...r }) => r) };
}

export interface DetailTurn {
  seq: number;
  kind: string;
  starter_index: number;
  starter_id: string;
  probe_index: number | null;
  probe_type: string | null;
  trigger: string | null;
  text: string | null;
  flags: Record<string, unknown>;
  created_at: Date;
  llm_outcome: string | null;
  llm_latency_ms: number | null;
  llm_error: string | null;
  llm_completion_tokens: number | null;
}

export interface SessionDetail {
  session: {
    session_id: string;
    participant_code: string | null;
    wave_id: string;
    status: string;
    is_preview: boolean;
    config_version: string;
    model: string;
    started_at: Date;
    ended_at: Date | null;
    turn_count: number;
  };
  turns: DetailTurn[];
}

/** One session's transcript with the model-call metadata joined in. Null unless it belongs to `surveyId`. */
export async function sessionDetail(pool: Pool, surveyId: string, sessionId: string): Promise<SessionDetail | null> {
  const s = await pool.query<SessionDetail['session']>(
    `SELECT id AS session_id, participant_code, wave_id, status::text, is_preview, config_version, model, started_at, ended_at, turn_count
       FROM survey.sessions WHERE id = $1 AND survey_id = $2`,
    [sessionId, surveyId],
  );
  const session = s.rows[0];
  if (!session) return null;
  const t = await pool.query<DetailTurn>(
    `SELECT t.seq, t.kind::text, t.starter_index, t.starter_id, t.probe_index, t.probe_type, t.trigger, t.text, t.flags, t.created_at,
            c.outcome::text AS llm_outcome, c.latency_ms AS llm_latency_ms, c.error AS llm_error,
            (c.response->'usage'->>'completion_tokens')::int AS llm_completion_tokens
       FROM survey.turns t LEFT JOIN survey.llm_calls c ON c.id = t.llm_call_id
      WHERE t.session_id = $1 ORDER BY t.seq`,
    [sessionId],
  );
  return { session, turns: t.rows };
}

export interface WaveStat {
  medianDurationS: number | null;
  probesPerSession: number | null;
  endedBy: Record<string, number>;
}

/** Per-wave summary over real (non-preview) sessions. */
export async function waveStats(pool: Pool, surveyId: string): Promise<Map<string, WaveStat>> {
  const a = await pool.query<{ wave_id: string; median_s: string | null; probes: string | null }>(
    `SELECT s.wave_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_activity_at) - s.started_at)))
              FILTER (WHERE s.status <> 'active') AS median_s,
            avg((SELECT count(*) FROM survey.turns t WHERE t.session_id = s.id AND t.kind = 'probe')) AS probes
       FROM survey.sessions s
      WHERE s.survey_id = $1 AND NOT s.is_preview
      GROUP BY s.wave_id`,
    [surveyId],
  );
  const b = await pool.query<{ wave_id: string; trigger: string; n: number }>(
    `SELECT s.wave_id, t.trigger, count(*)::int AS n
       FROM survey.turns t JOIN survey.sessions s ON s.id = t.session_id
      WHERE s.survey_id = $1 AND t.kind = 'advance' AND NOT s.is_preview
      GROUP BY 1, 2`,
    [surveyId],
  );
  const out = new Map<string, WaveStat>();
  for (const r of a.rows) {
    out.set(r.wave_id, {
      medianDurationS: r.median_s === null ? null : Math.round(Number(r.median_s)),
      probesPerSession: r.probes === null ? null : Math.round(Number(r.probes) * 10) / 10,
      endedBy: {},
    });
  }
  for (const r of b.rows) {
    const w = out.get(r.wave_id) ?? { medianDurationS: null, probesPerSession: null, endedBy: {} };
    w.endedBy[r.trigger] = r.n;
    out.set(r.wave_id, w);
  }
  return out;
}
