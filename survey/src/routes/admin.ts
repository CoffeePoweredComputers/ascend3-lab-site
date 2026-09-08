/**
 * Researcher and keyholder API (mounted at /api/admin). Roles come from each
 * survey file's `roles` block.
 *
 * Researcher (coded data only — no PID ever appears in these responses):
 *   GET  /surveys                                   surveys I have a role in, with counts
 *   GET  /s/:surveyId/export/sessions.csv | turns.csv | transcripts.jsonl   (?includePreview=1)
 *   POST /s/:surveyId/preview-session { waveId? }   a flagged session to try the instrument
 *   GET  /s/:surveyId/sessions?wave=&status=&includePreview=1&page=   paginated session list
 *   GET  /s/:surveyId/sessions/:sid[?download=1]      one transcript with model-call metadata
 *
 * Keyholder (identity side — the only place PIDs are handled):
 *   GET  /s/:surveyId/roster            PUT { pids: [...] }   replace-all
 *   GET  /s/:surveyId/keyring.csv       records an `export` event
 *   GET  /s/:surveyId/key-events
 *   POST /s/:surveyId/destroy-key { confirm: surveyId }   only when the survey is `closed`
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, readJson, requireApiIdentity, type AppContext, type AppEnv } from '../app.js';
import { hasAnyRole, rolesFor } from '../auth/roles.js';
import { isGuest } from '../auth/guest.js';
import type { LoadedSurvey } from '../config/load.js';
import { toCsv } from '../csv.js';
import { destroyKey, enrollmentCount, exportEnrollments, keyEvents, listRoster, replaceRoster, rosterSize } from '../store/keyring.js';
import {
  exportSessions,
  exportTranscripts,
  exportTurns,
  listSessions,
  SESSION_COLUMNS,
  sessionDetail,
  surveyCounts,
  TURN_COLUMNS,
  waveStats,
} from '../store/survey.js';

export function adminRoutes(ctx: AppContext): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireApiIdentity(ctx));

  function need(surveyId: string, pid: string, role: 'researcher' | 'keyholder'): LoadedSurvey {
    const loaded = ctx.registry.get(surveyId);
    if (isGuest(pid)) throw new HttpError(404, 'no_survey', 'No such survey');
    if (!loaded || !hasAnyRole(loaded.config, pid)) throw new HttpError(404, 'no_survey', 'No such survey');
    if (!rolesFor(loaded.config, pid)[role]) throw new HttpError(403, 'forbidden', `This action needs the ${role} role`);
    return loaded;
  }

  r.get('/surveys', async (c) => {
    const pid = c.get('pid');
    const out = [];
    for (const s of ctx.registry.list()) {
      if (!hasAnyRole(s.config, pid)) continue;
      const roles = rolesFor(s.config, pid);
      const counts = await surveyCounts(ctx.pools.survey, s.config.id);
      const byWave = new Map(counts.waves.map((w) => [w.waveId, w]));
      const stats = await waveStats(ctx.pools.survey, s.config.id);
      out.push({
        id: s.config.id,
        title: s.config.title,
        irbProtocol: s.config.irbProtocol ?? null,
        status: s.config.status,
        version: s.version,
        model: s.config.model.name,
        llmProvider: ctx.llmName,
        probing: {
          protocol: s.config.probing.protocol,
          maxProbesPerStarter: s.config.probing.maxProbesPerStarter,
          maxTurnsPerSession: s.config.probing.maxTurnsPerSession,
        },
        roles,
        participants: counts.participants,
        enrollments: roles.keyholder ? await enrollmentCount(ctx.pools.keyring, s.config.id) : null,
        rosterSize: roles.keyholder ? await rosterSize(ctx.pools.keyring, s.config.id) : null,
        rosterMode: s.config.eligibility.roster,
        waves: s.config.waves.map((w) => ({
          id: w.id,
          label: w.label,
          opensAt: w.opensAt,
          closesAt: w.closesAt,
          starters: w.starters.length,
          counts: byWave.get(w.id) ?? { waveId: w.id, active: 0, completed: 0, stopped: 0, expired: 0, previews: 0 },
          stats: stats.get(w.id) ?? { medianDurationS: null, probesPerSession: null, endedBy: {} },
        })),
      });
    }
    return c.json({ pid, surveys: out });
  });

  r.get('/s/:surveyId/export/:file', async (c) => {
    const pid = c.get('pid');
    const loaded = need(c.req.param('surveyId'), pid, 'researcher');
    const id = loaded.config.id;
    const includePreview = c.req.query('includePreview') === '1';
    const file = c.req.param('file');
    const stamp = new Date().toISOString().slice(0, 10);
    ctx.log.info('export', { surveyId: id, file, includePreview });
    if (file === 'sessions.csv') {
      c.header('Content-Disposition', `attachment; filename="${id}-sessions-${stamp}.csv"`);
      return c.body(toCsv(await exportSessions(ctx.pools.survey, id, includePreview), SESSION_COLUMNS), 200, { 'Content-Type': 'text/csv; charset=utf-8' });
    }
    if (file === 'turns.csv') {
      c.header('Content-Disposition', `attachment; filename="${id}-turns-${stamp}.csv"`);
      return c.body(toCsv(await exportTurns(ctx.pools.survey, id, includePreview), TURN_COLUMNS), 200, { 'Content-Type': 'text/csv; charset=utf-8' });
    }
    if (file === 'transcripts.jsonl') {
      const rows = await exportTranscripts(ctx.pools.survey, id, includePreview);
      c.header('Content-Disposition', `attachment; filename="${id}-transcripts-${stamp}.jsonl"`);
      return c.body(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    }
    throw new HttpError(404, 'no_export', 'Unknown export');
  });

  r.post('/s/:surveyId/preview-session', async (c) => {
    const pid = c.get('pid');
    const loaded = need(c.req.param('surveyId'), pid, 'researcher');
    const body = await readJson(c, z.object({ waveId: z.string().optional() }));
    const wave = body.waveId ? loaded.config.waves.find((w) => w.id === body.waveId) : loaded.config.waves[0];
    if (!wave) throw new HttpError(404, 'no_wave', 'No such wave');
    const view = await ctx.engine.start({ surveyId: loaded.config.id, waveId: wave.id, participantCode: null, isPreview: true });
    return c.json({ sessionId: view.session.id, url: `${ctx.env.basePath}/s/${loaded.config.id}?session=${view.session.id}` }, 201);
  });

  const SESSION_STATUSES = ['active', 'completed', 'stopped', 'expired'];
  const PAGE_SIZE = 50;

  r.get('/s/:surveyId/sessions', async (c) => {
    const loaded = need(c.req.param('surveyId'), c.get('pid'), 'researcher');
    const waveId = c.req.query('wave') || undefined;
    const status = c.req.query('status') || undefined;
    if (waveId && !loaded.config.waves.some((w) => w.id === waveId)) throw new HttpError(404, 'no_wave', 'No such wave');
    if (status && !SESSION_STATUSES.includes(status)) throw new HttpError(400, 'bad_status', 'Unknown status');
    const page = Math.max(1, Math.floor(Number(c.req.query('page') ?? '1')) || 1);
    const includePreview = c.req.query('includePreview') === '1';
    const { total, rows } = await listSessions(ctx.pools.survey, loaded.config.id, {
      ...(waveId ? { waveId } : {}),
      ...(status ? { status } : {}),
      includePreview,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    return c.json({ total, page, pageSize: PAGE_SIZE, rows });
  });

  r.get('/s/:surveyId/sessions/:sid', async (c) => {
    const loaded = need(c.req.param('surveyId'), c.get('pid'), 'researcher');
    const sid = c.req.param('sid');
    if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new HttpError(404, 'no_session', 'No such session');
    const detail = await sessionDetail(ctx.pools.survey, loaded.config.id, sid);
    if (!detail) throw new HttpError(404, 'no_session', 'No such session');
    if (c.req.query('download') === '1') {
      c.header('Content-Disposition', `attachment; filename="${loaded.config.id}-${sid}.json"`);
    }
    return c.json(detail);
  });

  /* ── keyholder ── */

  r.get('/s/:surveyId/roster', async (c) => {
    const loaded = need(c.req.param('surveyId'), c.get('pid'), 'keyholder');
    const pids = await listRoster(ctx.pools.keyring, loaded.config.id);
    return c.json({ pids, count: pids.length });
  });

  r.put('/s/:surveyId/roster', async (c) => {
    const pid = c.get('pid');
    const loaded = need(c.req.param('surveyId'), pid, 'keyholder');
    const body = await readJson(c, z.object({ pids: z.array(z.string().max(64)).max(5000) }));
    const bad = body.pids.map((p) => p.trim().toLowerCase()).filter((p) => p && !/^[a-z0-9][a-z0-9._-]*$/.test(p));
    if (bad.length) throw new HttpError(400, 'bad_pids', `Not PIDs: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`);
    const count = await replaceRoster(ctx.pools.keyring, loaded.config.id, body.pids, pid);
    ctx.log.info('roster.replace', { surveyId: loaded.config.id, count });
    return c.json({ count });
  });

  r.get('/s/:surveyId/keyring.csv', async (c) => {
    const pid = c.get('pid');
    const loaded = need(c.req.param('surveyId'), pid, 'keyholder');
    const rows = await exportEnrollments(ctx.pools.keyring, loaded.config.id, pid);
    ctx.log.info('keyring.export', { surveyId: loaded.config.id, rows: rows.length });
    c.header('Content-Disposition', `attachment; filename="${loaded.config.id}-keyring-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(
      toCsv(rows as unknown as Array<Record<string, unknown>>, ['code', 'pid', 'email', 'enrolled_at', 'ferpa_granted', 'ferpa_name', 'ferpa_date']),
      200,
      { 'Content-Type': 'text/csv; charset=utf-8' },
    );
  });

  r.get('/s/:surveyId/key-events', async (c) => {
    const loaded = need(c.req.param('surveyId'), c.get('pid'), 'keyholder');
    return c.json({ events: await keyEvents(ctx.pools.keyring, loaded.config.id) });
  });

  r.post('/s/:surveyId/destroy-key', async (c) => {
    const pid = c.get('pid');
    const loaded = need(c.req.param('surveyId'), pid, 'keyholder');
    const body = await readJson(c, z.object({ confirm: z.string() }));
    if (body.confirm !== loaded.config.id) throw new HttpError(400, 'confirm_mismatch', 'Type the survey id exactly to confirm');
    if (loaded.config.status !== 'closed') {
      throw new HttpError(409, 'survey_not_closed', 'Set the survey status to "closed" and redeploy before destroying the key');
    }
    const result = await destroyKey(ctx.pools.keyring, loaded.config.id, pid);
    ctx.log.warn('keyring.destroyed', { surveyId: loaded.config.id, ...result });
    return c.json(result);
  });

  return r;
}
