/**
 * The session state machine.
 *
 * A session walks a wave's starters in order. After each participant answer
 * the engine either asks the model for one more probe or advances; the
 * participant can skip ("Next question") or stop at any point. State lives in
 * `survey.sessions` and the append-only `survey.turns`; this module is the
 * only writer.
 *
 * Ordering guarantees (they matter for the IRB audit trail):
 *  - The participant's answer is COMMITTED before the model is called (tx1),
 *    so a model outage never loses an answer.
 *  - The probe or the advance is a second transaction (tx2) that re-locks the
 *    row and re-checks `seq`, so a concurrent skip/stop cannot interleave.
 *  - If the process dies between tx1 and tx2, the next `view()` sees a
 *    trailing `answer` row and finishes the decision — same code path.
 *  - Every action takes the client's `expectedSeq`; a stale double-submit
 *    gets 409 with the current state rather than a duplicate row.
 */
import type { ConfigRegistry, LoadedSurvey } from '../config/load.js';
import { maxProbesFor, type Starter, type SurveyConfig, type Wave } from '../config/schema.js';
import { withTx, type Client, type Pool } from '../db/pools.js';
import type { CompletionRequest, LlmClient } from '../llm/index.js';
import { extractContent, extractFinishReason, parseModelOutput, type ParseResult } from './parse.js';
import { buildMessages } from './prompt.js';
import type { AdvanceTrigger, SessionState, TurnRow } from './types.js';

export class SessionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionView {
  session: SessionState;
  /** Client-facing transcript: starter / probe / answer rows only. */
  transcript: TurnRow[];
  starterCount: number;
  maxProbes: number;
  /** The question awaiting an answer, or null when the session is over. */
  current: { kind: 'starter' | 'probe'; text: string; seq: number } | null;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/* ── pure helpers (unit-tested without a database) ─────────────────────────── */

export function canProbe(
  state: Pick<SessionState, 'probeCount' | 'turnCount'>,
  cfg: SurveyConfig,
  starter: Starter,
): { ok: true } | { ok: false; trigger: 'probe_limit' | 'turn_cap' } {
  if (state.probeCount >= maxProbesFor(cfg, starter)) return { ok: false, trigger: 'probe_limit' };
  if (state.turnCount >= cfg.probing.maxTurnsPerSession) return { ok: false, trigger: 'turn_cap' };
  return { ok: true };
}

export function waveIsOpen(wave: Wave, now = Date.now()): boolean {
  return now >= Date.parse(wave.opensAt) && now < Date.parse(wave.closesAt);
}

export function currentWave(cfg: SurveyConfig, now = Date.now()): Wave | null {
  return cfg.waves.find((w) => waveIsOpen(w, now)) ?? null;
}

export function nextWave(cfg: SurveyConfig, now = Date.now()): Wave | null {
  const future = cfg.waves.filter((w) => Date.parse(w.opensAt) > now).sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
  return future[0] ?? null;
}

export function generateCode(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return `P-${s}`;
}

/* ── row mapping ───────────────────────────────────────────────────────────── */

interface SessionRowDb {
  id: string;
  survey_id: string;
  wave_id: string;
  config_version: string;
  model: string;
  status: SessionState['status'];
  is_preview: boolean;
  starter_index: number;
  probe_count: number;
  turn_count: number;
  seq: number;
  participant_code: string | null;
}

interface TurnRowDb {
  seq: number;
  kind: TurnRow['kind'];
  starter_index: number;
  starter_id: string;
  probe_index: number | null;
  probe_type: string | null;
  trigger: string | null;
  text: string | null;
  flags: Record<string, unknown>;
  llm_call_id: string | number | null;
  created_at: Date;
}

const SESSION_COLS =
  'id, survey_id, wave_id, config_version, model, status, is_preview, starter_index, probe_count, turn_count, seq, participant_code';

function mapSession(r: SessionRowDb): SessionState & { participantCode: string | null } {
  return {
    id: r.id,
    surveyId: r.survey_id,
    waveId: r.wave_id,
    configVersion: r.config_version,
    model: r.model,
    status: r.status,
    isPreview: r.is_preview,
    starterIndex: r.starter_index,
    probeCount: r.probe_count,
    turnCount: r.turn_count,
    seq: r.seq,
    participantCode: r.participant_code,
  };
}

function mapTurn(r: TurnRowDb): TurnRow {
  return {
    seq: r.seq,
    kind: r.kind,
    starterIndex: r.starter_index,
    starterId: r.starter_id,
    probeIndex: r.probe_index,
    probeType: r.probe_type,
    trigger: r.trigger,
    text: r.text,
    flags: r.flags ?? {},
    llmCallId: r.llm_call_id == null ? null : Number(r.llm_call_id),
    createdAt: r.created_at?.toISOString(),
  };
}

export type OwnedSession = SessionState & { participantCode: string | null };

/* ── engine ────────────────────────────────────────────────────────────────── */

type Decision =
  | { action: 'probe'; probe: Extract<ParseResult, { kind: 'probe' }>; call: LlmCallRecord }
  | { action: 'advance'; trigger: AdvanceTrigger; call: LlmCallRecord | null };

interface LlmCallRecord {
  request: unknown;
  response: unknown;
  outcome: 'probe' | 'move_on' | 'error' | 'parse_error';
  error: string | null;
  latencyMs: number;
}

export class SessionEngine {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pool: Pool,
    private readonly registry: ConfigRegistry,
    private readonly llm: LlmClient,
    private readonly log: Logger,
  ) {}

  /* lookups */

  async find(sessionId: string): Promise<OwnedSession | null> {
    const { rows } = await this.pool.query<SessionRowDb>(`SELECT ${SESSION_COLS} FROM survey.sessions WHERE id = $1`, [sessionId]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async findForParticipant(participantCode: string, waveId: string): Promise<OwnedSession | null> {
    const { rows } = await this.pool.query<SessionRowDb>(
      `SELECT ${SESSION_COLS} FROM survey.sessions WHERE participant_code = $1 AND wave_id = $2 AND NOT is_preview`,
      [participantCode, waveId],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  /* actions */

  async start(opts: { surveyId: string; waveId: string; participantCode: string | null; isPreview: boolean }): Promise<SessionView> {
    const loaded = this.registry.get(opts.surveyId);
    if (!loaded) throw new SessionError(404, 'no_survey', 'Unknown survey');
    const wave = loaded.config.waves.find((w) => w.id === opts.waveId);
    if (!wave) throw new SessionError(404, 'no_wave', 'Unknown wave');
    const first = wave.starters[0]!;

    const id = await withTx(this.pool, async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO survey.sessions (survey_id, participant_code, wave_id, config_version, model, is_preview, starter_index, probe_count, turn_count, seq)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 1, 1) RETURNING id`,
        [opts.surveyId, opts.participantCode, opts.waveId, loaded.version, loaded.config.model.name, opts.isPreview],
      );
      const sid = ins.rows[0]!.id;
      await insertTurn(c, sid, loaded.version, { seq: 1, kind: 'starter', starterIndex: 0, starterId: first.id, probeIndex: 0, text: first.text });
      return sid;
    });
    this.log.info('session.start', { sessionId: id, surveyId: opts.surveyId, waveId: opts.waveId, preview: opts.isPreview });
    return this.view(id);
  }

  /** Current state; also performs crash recovery and wave-expiry housekeeping. */
  async view(sessionId: string): Promise<SessionView> {
    return this.withLock(sessionId, async () => {
      let state = await this.find(sessionId);
      if (!state) throw new SessionError(404, 'no_session', 'Unknown session');
      const { config, wave } = this.resolve(state);

      if (state.status === 'active' && !state.isPreview && !waveIsOpen(wave)) {
        await withTx(this.pool, async (c) => {
          const locked = await lockSession(c, sessionId);
          if (locked.status !== 'active') return;
          await insertTurn(c, sessionId, locked.configVersion, advanceRow(locked, wave, 'wave_closed', null));
          await c.query(`UPDATE survey.sessions SET status = 'expired', ended_at = now(), seq = seq + 1 WHERE id = $1`, [sessionId]);
        });
        this.log.info('session.expired', { sessionId });
        state = (await this.find(sessionId))!;
      }

      if (state.status === 'active') {
        const turns = await this.turns(sessionId);
        const last = turns[turns.length - 1];
        if (last?.kind === 'answer') {
          this.log.warn('session.recover', { sessionId, seq: state.seq });
          await this.decideAndApply(state, config, wave, turns);
        }
      }
      return this.buildView(sessionId);
    });
  }

  async answer(sessionId: string, text: string, expectedSeq: number): Promise<SessionView> {
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (!clean) throw new SessionError(400, 'empty_answer', 'Answer is empty');
    if (clean.length > 20_000) throw new SessionError(413, 'answer_too_long', 'Answer is too long');

    return this.withLock(sessionId, async () => {
      const afterTx1 = await withTx(this.pool, async (c) => {
        const s = await lockSession(c, sessionId);
        assertActionable(s, expectedSeq);
        const last = await lastTurn(c, sessionId);
        if (!last || (last.kind !== 'starter' && last.kind !== 'probe')) {
          throw new SessionError(409, 'no_question_pending', 'No question is awaiting an answer');
        }
        const seq = s.seq + 1;
        await insertTurn(c, sessionId, s.configVersion, {
          seq,
          kind: 'answer',
          starterIndex: s.starterIndex,
          starterId: last.starterId,
          probeIndex: s.probeCount,
          text: clean,
        });
        await c.query(`UPDATE survey.sessions SET seq = $2, last_activity_at = now() WHERE id = $1`, [sessionId, seq]);
        return { ...s, seq };
      });

      const { config, wave } = this.resolve(afterTx1);
      const turns = await this.turns(sessionId);
      await this.decideAndApply(afterTx1, config, wave, turns);
      return this.buildView(sessionId);
    });
  }

  async skip(sessionId: string, expectedSeq: number): Promise<SessionView> {
    return this.withLock(sessionId, async () => {
      await withTx(this.pool, async (c) => {
        const s = await lockSession(c, sessionId);
        assertActionable(s, expectedSeq);
        const { wave } = this.resolve(s);
        await applyAdvance(c, s, wave, 'skipped', null);
      });
      this.log.info('session.skip', { sessionId });
      return this.buildView(sessionId);
    });
  }

  async stop(sessionId: string, expectedSeq: number): Promise<SessionView> {
    return this.withLock(sessionId, async () => {
      await withTx(this.pool, async (c) => {
        const s = await lockSession(c, sessionId);
        assertActionable(s, expectedSeq);
        const { wave } = this.resolve(s);
        const starter = wave.starters[s.starterIndex]!;
        const seq = s.seq + 1;
        await insertTurn(c, sessionId, s.configVersion, { seq, kind: 'stop', starterIndex: s.starterIndex, starterId: starter.id, probeIndex: null });
        await c.query(`UPDATE survey.sessions SET status = 'stopped', ended_at = now(), seq = $2, last_activity_at = now() WHERE id = $1`, [sessionId, seq]);
      });
      this.log.info('session.stop', { sessionId });
      return this.buildView(sessionId);
    });
  }

  /* internals */

  private resolve(state: SessionState): { loaded: LoadedSurvey; config: SurveyConfig; wave: Wave } {
    const loaded = this.registry.getVersion(state.configVersion);
    if (!loaded) throw new SessionError(500, 'no_config_version', `Config version ${state.configVersion.slice(0, 12)} is not loaded`);
    const wave = loaded.config.waves.find((w) => w.id === state.waveId);
    if (!wave) throw new SessionError(500, 'no_wave', `Wave ${state.waveId} missing from pinned config`);
    return { loaded, config: loaded.config, wave };
  }

  private async turns(sessionId: string): Promise<TurnRow[]> {
    const { rows } = await this.pool.query<TurnRowDb>(
      `SELECT seq, kind, starter_index, starter_id, probe_index, probe_type, trigger, text, flags, llm_call_id, created_at
         FROM survey.turns WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    return rows.map(mapTurn);
  }

  private async buildView(sessionId: string): Promise<SessionView> {
    const state = (await this.find(sessionId))!;
    const { config, wave } = this.resolve(state);
    const all = await this.turns(sessionId);
    const transcript = all.filter((t) => t.kind === 'starter' || t.kind === 'probe' || t.kind === 'answer');
    const last = all[all.length - 1];
    const current =
      state.status === 'active' && last && (last.kind === 'starter' || last.kind === 'probe')
        ? { kind: last.kind, text: last.text ?? '', seq: last.seq }
        : null;
    const starter = wave.starters[Math.min(state.starterIndex, wave.starters.length - 1)]!;
    const { participantCode: _omit, ...session } = state;
    return { session, transcript, starterCount: wave.starters.length, maxProbes: maxProbesFor(config, starter), current };
  }

  /** Decide (maybe calling the model) and apply the result in tx2. `state.seq` must be the post-answer seq. */
  private async decideAndApply(state: SessionState, config: SurveyConfig, wave: Wave, turns: TurnRow[]): Promise<void> {
    const starter = wave.starters[state.starterIndex]!;
    const decision = await this.decide(state, config, starter, turns);

    await withTx(this.pool, async (c) => {
      const s = await lockSession(c, state.id);
      if (s.status !== 'active' || s.seq !== state.seq) {
        // A skip/stop landed while the model was thinking (only possible across processes). Keep their action; drop ours.
        this.log.warn('session.decision_dropped', { sessionId: state.id, expected: state.seq, actual: s.seq });
        return;
      }
      let callId: number | null = null;
      if (decision.call) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO survey.llm_calls (session_id, starter_index, probe_index, model, request, response, outcome, error, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            s.id,
            s.starterIndex,
            s.probeCount + 1,
            s.model,
            JSON.stringify(decision.call.request),
            decision.call.response == null ? null : JSON.stringify(decision.call.response),
            decision.call.outcome,
            decision.call.error,
            decision.call.latencyMs,
          ],
        );
        callId = Number(ins.rows[0]!.id);
      }
      if (decision.action === 'probe') {
        const seq = s.seq + 1;
        const probeIndex = s.probeCount + 1;
        await insertTurn(c, s.id, s.configVersion, {
          seq,
          kind: 'probe',
          starterIndex: s.starterIndex,
          starterId: starter.id,
          probeIndex,
          probeType: decision.probe.probeType,
          trigger: decision.probe.trigger,
          text: decision.probe.question,
          flags: decision.probe.flags,
          llmCallId: callId,
        });
        await c.query(
          `UPDATE survey.sessions SET probe_count = probe_count + 1, turn_count = turn_count + 1, seq = $2, last_activity_at = now() WHERE id = $1`,
          [s.id, seq],
        );
        this.log.info('session.probe', { sessionId: s.id, starterIndex: s.starterIndex, probeIndex, probeType: decision.probe.probeType, flags: Object.keys(decision.probe.flags) });
      } else {
        await applyAdvance(c, s, wave, decision.trigger, callId);
        this.log.info('session.advance', { sessionId: s.id, starterIndex: s.starterIndex, trigger: decision.trigger });
      }
    });
  }

  private async decide(state: SessionState, config: SurveyConfig, starter: Starter, turns: TurnRow[]): Promise<Decision> {
    const gate = canProbe(state, config, starter);
    if (!gate.ok) return { action: 'advance', trigger: gate.trigger, call: null };

    const starterTurns = turns.filter(
      (t) => t.starterIndex === state.starterIndex && (t.kind === 'starter' || t.kind === 'probe' || t.kind === 'answer'),
    );
    const messages = buildMessages(config, starter, starterTurns, state.probeCount, maxProbesFor(config, starter));
    const req: CompletionRequest = {
      model: config.model.name,
      messages,
      temperature: config.model.temperature,
      maxTokens: config.model.maxTokens,
      timeoutMs: config.model.timeoutMs,
      ...(config.model.reasoningEffort ? { reasoningEffort: config.model.reasoningEffort } : {}),
      hints: { probeTypes: config.probing.probeTypes, moveOnToken: config.probing.moveOnToken },
    };
    const request = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    };
    const started = Date.now();
    try {
      const res = await this.llm.complete(req);
      let parsed = parseModelOutput(extractContent(res.body), {
        probeTypes: config.probing.probeTypes,
        moveOnToken: config.probing.moveOnToken,
        maxQuestionWords: config.probing.maxQuestionWords,
      });
      if (parsed.kind === 'parse_error' && extractFinishReason(res.body) === 'length') {
        parsed = { kind: 'parse_error', reason: `truncated: finish_reason=length at max_tokens=${config.model.maxTokens} (${parsed.reason})` };
      }
      const call: LlmCallRecord = {
        request,
        response: res.body,
        outcome: parsed.kind === 'probe' ? 'probe' : parsed.kind === 'move_on' ? 'move_on' : 'parse_error',
        error: parsed.kind === 'parse_error' ? parsed.reason : null,
        latencyMs: res.latencyMs,
      };
      if (parsed.kind === 'probe') return { action: 'probe', probe: parsed, call };
      if (parsed.kind === 'move_on') return { action: 'advance', trigger: 'move_on', call };
      this.log.warn('llm.parse_error', { sessionId: state.id, reason: parsed.reason });
      return { action: 'advance', trigger: 'parse_error', call };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error('llm.error', { sessionId: state.id, error: message.slice(0, 300) });
      return {
        action: 'advance',
        trigger: 'llm_error',
        call: { request, response: null, outcome: 'error', error: message.slice(0, 1000), latencyMs: Date.now() - started },
      };
    }
  }

  /** Serialise work per session in this process. The chained promise never rejects; callers handle `run`'s errors. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }
}

/* ── SQL helpers ───────────────────────────────────────────────────────────── */

async function lockSession(c: Client, sessionId: string): Promise<OwnedSession> {
  const { rows } = await c.query<SessionRowDb>(`SELECT ${SESSION_COLS} FROM survey.sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
  if (!rows[0]) throw new SessionError(404, 'no_session', 'Unknown session');
  return mapSession(rows[0]);
}

function assertActionable(s: SessionState, expectedSeq: number): void {
  if (s.status !== 'active') throw new SessionError(410, 'session_over', 'This session has ended');
  if (!Number.isInteger(expectedSeq) || expectedSeq !== s.seq) throw new SessionError(409, 'stale', 'Session has moved on');
}

async function lastTurn(c: Client, sessionId: string): Promise<TurnRow | null> {
  const { rows } = await c.query<TurnRowDb>(
    `SELECT seq, kind, starter_index, starter_id, probe_index, probe_type, trigger, text, flags, llm_call_id, created_at
       FROM survey.turns WHERE session_id = $1 ORDER BY seq DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ? mapTurn(rows[0]) : null;
}

interface NewTurn {
  seq: number;
  kind: TurnRow['kind'];
  starterIndex: number;
  starterId: string;
  probeIndex: number | null;
  probeType?: string | null;
  trigger?: string | null;
  text?: string | null;
  flags?: Record<string, unknown>;
  llmCallId?: number | null;
}

async function insertTurn(c: Client, sessionId: string, configVersion: string, t: NewTurn): Promise<void> {
  await c.query(
    `INSERT INTO survey.turns (session_id, seq, kind, starter_index, starter_id, probe_index, probe_type, trigger, text, flags, config_version, llm_call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      sessionId,
      t.seq,
      t.kind,
      t.starterIndex,
      t.starterId,
      t.probeIndex,
      t.probeType ?? null,
      t.trigger ?? null,
      t.text ?? null,
      JSON.stringify(t.flags ?? {}),
      configVersion,
      t.llmCallId ?? null,
    ],
  );
}

function advanceRow(s: SessionState, wave: Wave, trigger: AdvanceTrigger, callId: number | null): NewTurn {
  const starter = wave.starters[Math.min(s.starterIndex, wave.starters.length - 1)]!;
  return { seq: s.seq + 1, kind: 'advance', starterIndex: s.starterIndex, starterId: starter.id, probeIndex: null, trigger, llmCallId: callId };
}

/** Close the current starter and either present the next one or complete the session. Caller holds the row lock. */
async function applyAdvance(c: Client, s: SessionState, wave: Wave, trigger: AdvanceTrigger, callId: number | null): Promise<void> {
  await insertTurn(c, s.id, s.configVersion, advanceRow(s, wave, trigger, callId));
  const nextIndex = s.starterIndex + 1;
  const next = wave.starters[nextIndex];
  if (next) {
    await insertTurn(c, s.id, s.configVersion, { seq: s.seq + 2, kind: 'starter', starterIndex: nextIndex, starterId: next.id, probeIndex: 0, text: next.text });
    await c.query(
      `UPDATE survey.sessions SET starter_index = $2, probe_count = 0, turn_count = turn_count + 1, seq = $3, last_activity_at = now() WHERE id = $1`,
      [s.id, nextIndex, s.seq + 2],
    );
  } else {
    await c.query(`UPDATE survey.sessions SET status = 'completed', ended_at = now(), seq = $2, last_activity_at = now() WHERE id = $1`, [s.id, s.seq + 1]);
  }
}
