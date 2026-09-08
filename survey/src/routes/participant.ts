/**
 * Participant API (mounted at /api).
 *
 *   GET  /s/:surveyId/state          where am I? (consent / closed / ready / in_session / completed)
 *   POST /s/:surveyId/consent        enrol: 18+ + agree (+ optional FERPA name/date)
 *   POST /s/:surveyId/sessions       start or resume the session for the open wave
 *   POST /sessions/:sid/answer       { text, expectedSeq }
 *   POST /sessions/:sid/skip         { expectedSeq }      "Next question"
 *   POST /sessions/:sid/stop         { expectedSeq }      ends the session, data kept
 *
 * A researcher may drive a *preview* session (participant_code NULL) by
 * passing ?session=<id>; previews skip consent and ignore wave windows.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { hasAnyRole, rolesFor } from '../auth/roles.js';
import { isGuest } from '../auth/guest.js';
import { HttpError, readJson, requireApiIdentity, type AppContext, type AppEnv, type Ctx } from '../app.js';
import type { LoadedSurvey } from '../config/load.js';
import type { Wave } from '../config/schema.js';
import { currentWave, nextWave, SessionError, type OwnedSession, type SessionView } from '../engine/session.js';
import { findEnrollment, insertEnrollment, onRoster, withEnrollmentLock, type Enrollment } from '../store/keyring.js';
import { ensureParticipant, insertParticipant } from '../store/survey.js';
import { isUniqueViolation } from '../db/pools.js';

const consentBody = z.object({
  adult: z.boolean(),
  agree: z.boolean(),
  rosterAttest: z.boolean().optional(),
  ferpa: z
    .object({
      granted: z.boolean(),
      name: z.string().max(200).optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .optional(),
});

const actionBody = z.object({
  text: z.string().max(20_000).optional(),
  expectedSeq: z.number().int().min(0),
});

function waveMeta(w: Wave) {
  return { id: w.id, label: w.label, opensAt: w.opensAt, closesAt: w.closesAt };
}

function surveyMeta(s: LoadedSurvey) {
  const c = s.config;
  return {
    id: c.id,
    title: c.title,
    irbProtocol: c.irbProtocol ?? null,
    status: c.status,
    opening: c.opening,
    closing: c.closing,
    waves: c.waves.map(waveMeta),
  };
}

export function participantRoutes(ctx: AppContext): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireApiIdentity(ctx));

  /** Survey lookup honouring `draft` visibility. */
  function resolveSurvey(surveyId: string, pid: string): { loaded: LoadedSurvey; roles: ReturnType<typeof rolesFor> } {
    const loaded = ctx.registry.get(surveyId);
    if (!loaded) throw new HttpError(404, 'no_survey', 'No such survey');
    // A guest identity is confined to the survey that invited it; every other
    // survey is simply not there. (Roles are unreachable for guests anyway —
    // `guest:` can never match a PID — but this keeps them off the instrument.)
    if (isGuest(pid) && !loaded.config.eligibility.guestAccess) throw new HttpError(404, 'no_survey', 'No such survey');
    const roles = rolesFor(loaded.config, pid);
    if (loaded.config.status === 'draft' && !hasAnyRole(loaded.config, pid)) throw new HttpError(404, 'no_survey', 'No such survey');
    return { loaded, roles };
  }

  /** A session the caller may act on: their own (by code) or a preview they are a researcher for. */
  async function sessionAccess(sid: string, pid: string): Promise<OwnedSession> {
    if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new HttpError(404, 'no_session', 'No such session');
    const s = await ctx.engine.find(sid);
    if (!s) throw new HttpError(404, 'no_session', 'No such session');
    const loaded = ctx.registry.get(s.surveyId);
    if (s.isPreview) {
      if (!loaded || !rolesFor(loaded.config, pid).researcher) throw new HttpError(403, 'forbidden', 'Not your session');
      return s;
    }
    const enrollment = await findEnrollment(ctx.pools.keyring, s.surveyId, pid);
    if (!enrollment || enrollment.code !== s.participantCode) throw new HttpError(403, 'forbidden', 'Not your session');
    return s;
  }

  r.get('/s/:surveyId/state', async (c) => {
    const pid = c.get('pid');
    const { loaded, roles } = resolveSurvey(c.req.param('surveyId'), pid);
    const cfg = loaded.config;
    const base = { survey: surveyMeta(loaded), pid, roles };

    const previewId = c.req.query('session');
    if (previewId) {
      const s = await sessionAccess(previewId, pid);
      if (!s.isPreview) throw new HttpError(400, 'not_preview', 'Not a preview session');
      const view = await ctx.engine.view(s.id);
      const pinned = ctx.registry.getVersion(s.configVersion)?.config ?? cfg;
      const wave = pinned.waves.find((w) => w.id === s.waveId);
      return c.json({
        ...base,
        preview: true,
        phase: view.session.status === 'active' ? 'in_session' : 'completed',
        wave: wave ? waveMeta(wave) : null,
        sessionStatus: view.session.status,
        view,
      });
    }

    const enrollment = await findEnrollment(ctx.pools.keyring, cfg.id, pid);
    if (!enrollment) {
      const rosterMode = cfg.eligibility.roster;
      return c.json({
        ...base,
        phase: 'consent',
        consent: {
          sheetHtml: loaded.sheetHtml,
          agreeLabel: cfg.consent.agreeLabel,
          declineLabel: cfg.consent.declineLabel,
          requireAdult: cfg.eligibility.requireAdult,
          ferpa: cfg.consent.ferpa?.enabled ? cfg.consent.ferpa : null,
          rosterMode,
          onRoster: rosterMode === 'none' ? null : await onRoster(ctx.pools.keyring, cfg.id, pid),
        },
      });
    }
    await ensureParticipant(ctx.pools.survey, enrollment.code, cfg.id, enrollment.ferpaGranted);

    if (cfg.status !== 'open') return c.json({ ...base, phase: 'closed', reason: 'survey_closed' });
    const wave = currentWave(cfg);
    if (!wave) {
      const upcoming = nextWave(cfg);
      return c.json({
        ...base,
        phase: 'closed',
        reason: upcoming ? 'not_yet_open' : 'no_open_wave',
        nextWave: upcoming ? waveMeta(upcoming) : null,
      });
    }
    const existing = await ctx.engine.findForParticipant(enrollment.code, wave.id);
    if (!existing) return c.json({ ...base, phase: 'ready', wave: waveMeta(wave) });
    const view = await ctx.engine.view(existing.id);
    return c.json({
      ...base,
      phase: view.session.status === 'active' ? 'in_session' : 'completed',
      wave: waveMeta(wave),
      sessionStatus: view.session.status,
      view,
    });
  });

  r.post('/s/:surveyId/consent', async (c) => {
    const pid = c.get('pid');
    const { loaded } = resolveSurvey(c.req.param('surveyId'), pid);
    const cfg = loaded.config;
    const body = await readJson(c, consentBody);

    if (!body.agree) throw new HttpError(400, 'must_agree', 'Consent is required to continue');
    if (cfg.eligibility.requireAdult && !body.adult) throw new HttpError(400, 'must_be_adult', 'You must be 18 or older to take part');

    let rosterMatched: boolean | null = null;
    if (cfg.eligibility.roster !== 'none') {
      rosterMatched = await onRoster(ctx.pools.keyring, cfg.id, pid);
      if (cfg.eligibility.roster === 'required' && !rosterMatched) {
        throw new HttpError(403, 'not_on_roster', 'Your account is not on the roster for this study');
      }
    }

    let ferpaGranted = false;
    let ferpaName: string | null = null;
    let ferpaDate: string | null = null;
    if (cfg.consent.ferpa?.enabled && body.ferpa?.granted) {
      ferpaGranted = true;
      if (cfg.consent.ferpa.requireNameAndDate) {
        const name = body.ferpa.name?.trim() ?? '';
        const date = body.ferpa.date ?? '';
        if (name.length < 2) throw new HttpError(400, 'ferpa_name', 'Type your full name to give the records permission, or leave the box unchecked');
        if (!date || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'ferpa_date', 'Enter the date to give the records permission');
        ferpaName = name;
        ferpaDate = date;
      }
    }

    const result = await withEnrollmentLock(ctx.pools.keyring, cfg.id, pid, async (kc) => {
      const existing = await kc.query('SELECT code FROM keyring.enrollments WHERE survey_id = $1 AND pid = $2', [cfg.id, pid]);
      if (existing.rowCount) return { already: true as const };
      const code = await insertParticipant(ctx.pools.survey, {
        surveyId: cfg.id,
        isAdult: body.adult,
        ferpaGranted,
        rosterMatched,
      });
      const ok = await insertEnrollment(kc, { surveyId: cfg.id, pid, code, ferpaGranted, ferpaName, ferpaDate });
      if (!ok) {
        ctx.log.warn('consent.orphan_participant', { surveyId: cfg.id, code });
        return { already: true as const };
      }
      return { code };
    });
    if ('already' in result) throw new HttpError(409, 'already_enrolled', 'You have already consented');
    ctx.log.info('consent.enrolled', { surveyId: cfg.id, code: result.code, ferpa: ferpaGranted, rosterMatched });
    return c.json({ ok: true }, 201);
  });

  r.post('/s/:surveyId/sessions', async (c) => {
    const pid = c.get('pid');
    const { loaded } = resolveSurvey(c.req.param('surveyId'), pid);
    const cfg = loaded.config;
    const enrollment: Enrollment | null = await findEnrollment(ctx.pools.keyring, cfg.id, pid);
    if (!enrollment) throw new HttpError(403, 'not_enrolled', 'Please read the information sheet and consent first');
    if (cfg.status !== 'open') throw new HttpError(409, 'survey_closed', 'This survey is closed');
    const wave = currentWave(cfg);
    if (!wave) throw new HttpError(409, 'no_open_wave', 'No survey wave is open right now');
    await ensureParticipant(ctx.pools.survey, enrollment.code, cfg.id, enrollment.ferpaGranted);

    const existing = await ctx.engine.findForParticipant(enrollment.code, wave.id);
    if (existing) return c.json({ view: await ctx.engine.view(existing.id), resumed: true });
    try {
      const view = await ctx.engine.start({ surveyId: cfg.id, waveId: wave.id, participantCode: enrollment.code, isPreview: false });
      return c.json({ view, resumed: false }, 201);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const raced = await ctx.engine.findForParticipant(enrollment.code, wave.id);
      if (!raced) throw e;
      return c.json({ view: await ctx.engine.view(raced.id), resumed: true });
    }
  });

  const act = (fn: (s: OwnedSession, body: z.infer<typeof actionBody>) => Promise<SessionView>) => async (c: Ctx) => {
    const s = await sessionAccess(c.req.param('sid') ?? '', c.get('pid'));
    const body = await readJson(c, actionBody);
    try {
      return c.json({ view: await fn(s, body) });
    } catch (e) {
      if (e instanceof SessionError && e.status === 409) {
        return c.json({ error: e.code, message: e.message, view: await ctx.engine.view(s.id) }, 409);
      }
      throw e;
    }
  };

  r.post('/sessions/:sid/answer', act((s, b) => ctx.engine.answer(s.id, b.text ?? '', b.expectedSeq)));
  r.post('/sessions/:sid/skip', act((s, b) => ctx.engine.skip(s.id, b.expectedSeq)));
  r.post('/sessions/:sid/stop', act((s, b) => ctx.engine.stop(s.id, b.expectedSeq)));

  return r;
}
