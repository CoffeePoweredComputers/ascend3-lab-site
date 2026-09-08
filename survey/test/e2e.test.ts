/**
 * In-process end-to-end test against a real Postgres (the local dev database
 * from survey/.env) with the mock model. Skipped when no database is configured.
 *
 *   docker run -d --name ascend-survey-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5433:5432 postgres:16
 *   psql ... -f deploy/provision.sql && npm run migrate:dev && npm test
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AppContext } from '../src/app.js';
import { buildApp } from '../src/build.js';
import { ConfigRegistry, loadSurveyDir } from '../src/config/load.js';
import { closePools, createPools, type Pools } from '../src/db/pools.js';
import { SessionEngine } from '../src/engine/session.js';
import { loadEnv, type Env } from '../src/env.js';
import { MockClient } from '../src/llm/mock.js';
import { LlmMonitor, mockProbe } from '../src/llm/monitor.js';
import { snapshotConfigs } from '../src/store/survey.js';

let env: Env | null = null;
try {
  process.env.LLM_PROVIDER = 'mock';
  process.env.DEV_LOGIN_ENABLED = '1';
  process.env.NODE_ENV = 'test';
  env = loadEnv();
} catch {
  env = null;
}
const skip = !env || !process.env.SURVEY_DATABASE_URL && !env.SURVEY_DATABASE_URL;

const silent = { info() {}, warn() {}, error() {} };
let pools: Pools;
let app: ReturnType<typeof buildApp>;
const ORIGIN = 'http://127.0.0.1:8787';
const B = '/survey';
const run = Date.now().toString(36);

before(async () => {
  if (skip) return;
  const e = { ...env!, BASE_URL: `${ORIGIN}${B}`, basePath: B, SURVEYS_DIR: 'test/fixtures/surveys', WEB_DIR: 'web' };
  const registry = new ConfigRegistry(loadSurveyDir(e.SURVEYS_DIR));
  pools = createPools(e);
  await snapshotConfigs(pools.survey, registry);
  const llm = new LlmMonitor(new MockClient(), { probe: mockProbe() });
  await llm.runProbe();
  const engine = new SessionEngine(pools.survey, registry, llm, silent);
  const ctx: AppContext = { env: e, registry, pools, engine, log: silent, llmName: 'mock', llmStatus: () => llm.status() };
  app = buildApp(ctx);
});
after(async () => {
  if (pools) await closePools(pools);
});

async function login(pid: string): Promise<string> {
  const res = await app.request(`${ORIGIN}${B}/auth/dev-login?pid=${pid}`);
  assert.equal(res.status, 302);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'cookie set');
  return setCookie.split(';')[0]!;
}

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: {
      cookie,
      'x-requested-with': 'fetch',
      origin: ORIGIN,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(`${ORIGIN}${B}${path}`, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

test('healthz and static shell', { skip }, async () => {
  const h = await app.request(`${ORIGIN}${B}/healthz`);
  assert.equal(h.status, 200);
  const page = await app.request(`${ORIGIN}${B}/s/e2e-demo`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-survey="e2e-demo"/);
  assert.match(html, new RegExp(`href="${B}/style.css"`));
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const css = await app.request(`${ORIGIN}${B}/style.css`);
  assert.equal(css.status, 200);
  const missing = await app.request(`${ORIGIN}${B}/s/nope-nope`);
  assert.equal(missing.status, 404);
});

test('unauthenticated API returns 401 with a CAS login URL; CSRF header is required', { skip }, async () => {
  const r = await app.request(`${ORIGIN}${B}/api/s/e2e-demo/state`);
  assert.equal(r.status, 401);
  const j: any = await r.json();
  assert.match(j.login, /login\.vt\.edu\/profile\/cas\/login\?service=/);
  const cookie = await login(`p${run}a`);
  const noHeader = await app.request(`${ORIGIN}${B}/api/s/e2e-demo/consent`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
});

test('participant flow: consent → start → answer/probe → skip → stop; exports are coded only', { skip }, async () => {
  const pid = `p${run}b`;
  const cookie = await login(pid);

  let r = await call(cookie, 'GET', '/api/s/e2e-demo/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.phase, 'consent');
  assert.match(r.json.consent.sheetHtml, /<strong>test<\/strong>/);
  assert.equal(r.json.consent.onRoster, false);

  // Cannot start before consent
  r = await call(cookie, 'POST', '/api/s/e2e-demo/sessions', {});
  assert.equal(r.status, 403);

  // Consent validation
  r = await call(cookie, 'POST', '/api/s/e2e-demo/consent', { adult: true, agree: false });
  assert.equal(r.status, 400);
  r = await call(cookie, 'POST', '/api/s/e2e-demo/consent', { adult: true, agree: true, ferpa: { granted: true, name: 'A', date: '2026-09-06' } });
  assert.equal(r.status, 400, 'ferpa needs a real name');
  r = await call(cookie, 'POST', '/api/s/e2e-demo/consent', { adult: true, agree: true, ferpa: { granted: true, name: 'Test Person', date: '2026-09-06' } });
  assert.equal(r.status, 201);
  r = await call(cookie, 'POST', '/api/s/e2e-demo/consent', { adult: true, agree: true });
  assert.equal(r.status, 409, 'second consent is rejected');

  r = await call(cookie, 'GET', '/api/s/e2e-demo/state');
  assert.equal(r.json.phase, 'ready');
  assert.equal(r.json.wave.id, 'w1');

  // Start → first starter presented
  r = await call(cookie, 'POST', '/api/s/e2e-demo/sessions', {});
  assert.equal(r.status, 201);
  let view = r.json.view;
  const sid = view.session.id;
  assert.equal(view.current.kind, 'starter');
  assert.equal(view.session.seq, 1);
  assert.equal(view.starterCount, 2);
  assert.equal(view.maxProbes, 2);

  // Resume returns the same session
  r = await call(cookie, 'POST', '/api/s/e2e-demo/sessions', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.view.session.id, sid);
  assert.equal(r.json.resumed, true);

  // Stale seq → 409 with current view
  r = await call(cookie, 'POST', `/api/sessions/${sid}/answer`, { text: 'hello there friend', expectedSeq: 99 });
  assert.equal(r.status, 409);
  assert.equal(r.json.view.session.seq, 1);

  // Long answer → mock asks a probe (answer seq 2, probe seq 3)
  r = await call(cookie, 'POST', `/api/sessions/${sid}/answer`, { text: 'We were not sure what the spec meant by finished so we argued for a while', expectedSeq: 1 });
  assert.equal(r.status, 200);
  view = r.json.view;
  assert.equal(view.current.kind, 'probe');
  assert.equal(view.session.probeCount, 1);
  assert.equal(view.session.turnCount, 2);
  assert.equal(view.session.seq, 3);
  const probe = view.transcript.find((t: any) => t.kind === 'probe');
  assert.equal(probe.probeType, 'DESCRIPTIVE_EXTERNAL');

  // Short answer → mock moves on → advance + next starter (seq 4 answer, 5 advance, 6 starter)
  r = await call(cookie, 'POST', `/api/sessions/${sid}/answer`, { text: 'not really', expectedSeq: 3 });
  assert.equal(r.status, 200);
  view = r.json.view;
  assert.equal(view.current.kind, 'starter');
  assert.equal(view.session.starterIndex, 1);
  assert.equal(view.session.probeCount, 0);
  assert.equal(view.session.turnCount, 3);
  assert.equal(view.session.seq, 6);

  // Answer second starter at length → probe (turnCount 4)
  r = await call(cookie, 'POST', `/api/sessions/${sid}/answer`, { text: 'It was a long negotiation between all of us over several days honestly', expectedSeq: 6 });
  assert.equal(r.status, 200);
  view = r.json.view;
  assert.equal(view.current.kind, 'probe');
  assert.equal(view.session.turnCount, 4);

  // Answer probe at length → would probe again but turn cap (5) → wait, cap is 5 and turnCount 4 < 5 so probe #2 happens
  r = await call(cookie, 'POST', `/api/sessions/${sid}/answer`, { text: 'Another long answer here with plenty of words in it to go on', expectedSeq: view.session.seq });
  view = r.json.view;
  assert.equal(view.current.kind, 'probe');
  assert.equal(view.session.probeCount, 2);
  assert.equal(view.session.turnCount, 5);

  // Skip the rest → last starter → completed
  r = await call(cookie, 'POST', `/api/sessions/${sid}/skip`, { expectedSeq: view.session.seq });
  assert.equal(r.status, 200);
  view = r.json.view;
  assert.equal(view.session.status, 'completed');
  assert.equal(view.current, null);

  // Acting on a finished session → 410
  r = await call(cookie, 'POST', `/api/sessions/${sid}/stop`, { expectedSeq: view.session.seq });
  assert.equal(r.status, 410);

  r = await call(cookie, 'GET', '/api/s/e2e-demo/state');
  assert.equal(r.json.phase, 'completed');
  assert.equal(r.json.sessionStatus, 'completed');

  // Another participant cannot touch this session
  const other = await login(`p${run}c`);
  r = await call(other, 'POST', `/api/sessions/${sid}/skip`, { expectedSeq: 0 });
  assert.equal(r.status, 403);

  // Researcher exports: coded, no PID anywhere
  const res = await login('researcher1');
  r = await call(res, 'GET', '/api/admin/surveys');
  assert.equal(r.status, 200);
  const demo = r.json.surveys.find((s: any) => s.id === 'e2e-demo');
  assert.ok(demo);
  assert.equal(demo.roles.keyholder, false);
  assert.equal(demo.enrollments, null, 'researcher does not see key counts');
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/export/turns.csv');
  assert.equal(r.status, 200);
  assert.match(r.text, /^session_id,participant_code,wave_id/);
  assert.ok(!r.text.includes(pid), 'PID must not appear in coded export');
  assert.match(r.text, /,advance,/);
  assert.match(r.text, /move_on/);
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/export/transcripts.jsonl');
  assert.equal(r.status, 200);
  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  const mine = lines.find((l: any) => l.session_id === sid);
  assert.ok(mine);
  assert.equal(mine.starters.length, 2);
  assert.equal(mine.starters[0].ended_by, 'move_on');
  assert.equal(mine.starters[1].ended_by, 'skipped');
  // Researcher is refused the key
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/keyring.csv');
  assert.equal(r.status, 403);

  // Keyholder: key export contains the pid and is logged; destroy refused while open
  const kh = await login('keyholder1');
  r = await call(kh, 'GET', '/api/admin/s/e2e-demo/keyring.csv');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(pid));
  assert.ok(r.text.includes('Test Person'));
  r = await call(kh, 'GET', '/api/admin/s/e2e-demo/key-events');
  assert.equal(r.json.events[0].event, 'export');
  r = await call(kh, 'POST', '/api/admin/s/e2e-demo/destroy-key', { confirm: 'e2e-demo' });
  assert.equal(r.status, 409);
  r = await call(kh, 'GET', '/api/admin/s/e2e-demo/export/turns.csv');
  assert.equal(r.status, 403, 'keyholder alone cannot export coded data');
  r = await call(kh, 'PUT', '/api/admin/s/e2e-demo/roster', { pids: ['Alice1', 'bob2', 'bob2'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 2);
});

test('preview session skips consent, ignores windows, is excluded from exports by default', { skip }, async () => {
  const res = await login('researcher1');
  let r = await call(res, 'POST', '/api/admin/s/e2e-demo/preview-session', { waveId: 'w1' });
  assert.equal(r.status, 201);
  const sid = r.json.sessionId;
  assert.match(r.json.url, new RegExp(`${B}/s/e2e-demo\\?session=${sid}`));
  r = await call(res, 'GET', `/api/s/e2e-demo/state?session=${sid}`);
  assert.equal(r.json.phase, 'in_session');
  assert.equal(r.json.preview, true);
  r = await call(res, 'POST', `/api/sessions/${sid}/stop`, { expectedSeq: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.view.session.status, 'stopped');
  const withoutPreview = await call(res, 'GET', '/api/admin/s/e2e-demo/export/sessions.csv');
  assert.ok(!withoutPreview.text.includes(sid));
  const withPreview = await call(res, 'GET', '/api/admin/s/e2e-demo/export/sessions.csv?includePreview=1');
  assert.ok(withPreview.text.includes(sid));
  // A non-researcher cannot drive the preview
  const stranger = await login(`p${run}d`);
  r = await call(stranger, 'GET', `/api/s/e2e-demo/state?session=${sid}`);
  assert.equal(r.status, 403);
});

test('results viewer: session list, transcript detail with model metadata, role checks; llm-status', { skip }, async () => {
  // fresh participant → one completed session
  const pid = `p${run}v`;
  const cookie = await login(pid);
  await call(cookie, 'POST', '/api/s/e2e-demo/consent', { adult: true, agree: true });
  let r = await call(cookie, 'POST', '/api/s/e2e-demo/sessions', {});
  const sid: string = r.json.view.session.id;
  r = await call(cookie, 'POST', `/api/sessions/${sid}/answer`, { text: 'We were unsure for a long time about what finished even meant', expectedSeq: 1 });
  assert.equal(r.json.view.current.kind, 'probe');
  r = await call(cookie, 'POST', `/api/sessions/${sid}/skip`, { expectedSeq: r.json.view.session.seq });
  r = await call(cookie, 'POST', `/api/sessions/${sid}/skip`, { expectedSeq: r.json.view.session.seq });
  assert.equal(r.json.view.session.status, 'completed');

  const res = await login('researcher1');
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/sessions?wave=w1&status=completed');
  assert.equal(r.status, 200);
  assert.ok(r.json.total >= 1);
  const row = r.json.rows.find((x: any) => x.session_id === sid);
  assert.ok(row, 'our session is listed');
  assert.equal(row.probes_asked, 1);
  assert.equal(row.starters_answered, 1);
  assert.equal(row.ended_by.skipped, 2);
  assert.ok(!r.text.includes(pid));
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/sessions?status=bogus');
  assert.equal(r.status, 400);
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/sessions?wave=nope');
  assert.equal(r.status, 404);

  r = await call(res, 'GET', `/api/admin/s/e2e-demo/sessions/${sid}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.session.session_id, sid);
  const probe = r.json.turns.find((t: any) => t.kind === 'probe');
  assert.equal(probe.llm_outcome, 'probe');
  assert.equal(typeof probe.llm_latency_ms, 'number');
  assert.ok(r.json.turns.some((t: any) => t.kind === 'advance' && t.trigger === 'skipped'));
  r = await call(res, 'GET', `/api/admin/s/e2e-demo/sessions/${sid}?download=1`);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment/);
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/sessions/00000000-0000-0000-0000-000000000000');
  assert.equal(r.status, 404);
  r = await call(res, 'GET', '/api/admin/s/e2e-demo/sessions/not-a-uuid');
  assert.equal(r.status, 404);

  // wave stats ride along on /surveys
  r = await call(res, 'GET', '/api/admin/surveys');
  const demo = r.json.surveys.find((s: any) => s.id === 'e2e-demo');
  assert.ok(demo.waves[0].stats);
  assert.ok(demo.waves[0].stats.endedBy.skipped >= 2);

  // keyholder alone cannot read sessions; strangers get 404
  const kh = await login('keyholder1');
  r = await call(kh, 'GET', '/api/admin/s/e2e-demo/sessions');
  assert.equal(r.status, 403);
  const stranger = await login(`p${run}w`);
  r = await call(stranger, 'GET', `/api/admin/s/e2e-demo/sessions/${sid}`);
  assert.equal(r.status, 404);

  // llm-status: login required; mock reports ok
  const anon = await app.request(`${ORIGIN}${B}/api/llm-status`);
  assert.equal(anon.status, 401);
  r = await call(cookie, 'GET', '/api/llm-status');
  assert.equal(r.status, 200);
  assert.equal(r.json.provider, 'mock');
  assert.equal(r.json.state, 'ok');
  assert.equal(r.json.lastCall.ok, true);
});
