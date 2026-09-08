/**
 * Guest invite tokens (src/auth/guest.ts) — the only non-CAS way in, so the
 * tests are about what it must refuse. No database needed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inviteUrl, isGuest, mintInvite, newGuestPid, verifyInvite } from '../src/auth/guest.js';
import type { Env } from '../src/env.js';

const env = {
  SESSION_SECRET: 'x'.repeat(48),
  BASE_URL: 'https://example.test/survey',
  basePath: '/survey',
} as unknown as Env;

const other = { ...env, SESSION_SECRET: 'y'.repeat(48) } as Env;
const soon = () => new Date(Date.now() + 60_000);

test('a freshly minted token verifies and names its survey', () => {
  assert.equal(verifyInvite(env, mintInvite(env, 'pilot', soon())), 'pilot');
});

test('a token is useless without the secret that signed it', () => {
  assert.equal(verifyInvite(other, mintInvite(env, 'pilot', soon())), null);
});

test('an invite for one survey is not an invite for another', () => {
  const t = mintInvite(env, 'pilot', soon());
  const [v, , exp, mac] = t.split('.');
  assert.equal(verifyInvite(env, [v, 'irb-26-817', exp, mac].join('.')), null);
});

test('the expiry is signed, so it cannot be pushed out', () => {
  const t = mintInvite(env, 'pilot', soon());
  const [v, id, , mac] = t.split('.');
  const later = String(Math.floor(Date.now() / 1000) + 999_999);
  assert.equal(verifyInvite(env, [v, id, later, mac].join('.')), null);
});

test('an expired token is refused', () => {
  assert.equal(verifyInvite(env, mintInvite(env, 'pilot', new Date(Date.now() - 1000))), null);
});

test('malformed tokens are refused rather than throwing', () => {
  for (const t of ['', '.', 'g1.pilot', 'g1.pilot.999.', 'a.b.c.d', 'g2.pilot.999.abc', mintInvite(env, 'pilot', soon()) + '.x']) {
    assert.equal(verifyInvite(env, t), null, `should refuse ${JSON.stringify(t)}`);
  }
});

test('guest identities can never be mistaken for a PID, so they can never hold a role', () => {
  const pidPattern = /^[a-z0-9][a-z0-9._-]*$/; // config/schema.ts
  for (let i = 0; i < 200; i++) {
    const g = newGuestPid();
    assert.ok(isGuest(g));
    assert.ok(!pidPattern.test(g), `${g} must not look like a PID`);
  }
  assert.equal(new Set(Array.from({ length: 200 }, newGuestPid)).size, 200, 'guest ids are unique');
  assert.ok(!isGuest('dhsmith4'));
});

test('the invite URL points at this deployment', () => {
  const url = new URL(inviteUrl(env, 'pilot', soon()));
  assert.equal(url.pathname, '/survey/auth/invite');
  assert.equal(verifyInvite(env, url.searchParams.get('t')!), 'pilot');
});

/* ── Containment: what a guest identity can and cannot reach ──────────────────
 * Built against the real app. Every route exercised here answers before it
 * touches Postgres, so the pools below are never connected.
 */
import { buildApp } from '../src/build.js';
import { ConfigRegistry, fromRaw } from '../src/config/load.js';
import { createPools } from '../src/db/pools.js';
import { SessionEngine } from '../src/engine/session.js';
import { MockClient } from '../src/llm/mock.js';
import { LlmMonitor, mockProbe } from '../src/llm/monitor.js';
import { readFileSync } from 'node:fs';
import type { AppContext } from '../src/app.js';

const appEnv = {
  NODE_ENV: 'test',
  PORT: 8787,
  BASE_URL: 'http://127.0.0.1/survey',
  CAS_BASE_URL: 'https://login.vt.edu/profile/cas',
  SESSION_SECRET: 'x'.repeat(48),
  LLM_PROVIDER: 'mock',
  ARC_LLM_BASE_URL: 'https://llm-api.arc.vt.edu/api/v1',
  ARC_LLM_API_KEY: '',
  SURVEY_DATABASE_URL: 'postgresql://none:none@127.0.0.1:1/none',
  KEYRING_DATABASE_URL: 'postgresql://none:none@127.0.0.1:1/none',
  MIGRATE_DATABASE_URL: '',
  DEV_LOGIN_ENABLED: false,
  SURVEYS_DIR: 'surveys',
  WEB_DIR: 'web',
  basePath: '/survey',
  isProduction: false,
} satisfies Env;

const template: Record<string, unknown> = JSON.parse(readFileSync('templates/minimal.json', 'utf8'));
const survey = (id: string, guestAccess: boolean) =>
  fromRaw(
    { ...template, id, title: id, status: 'open', eligibility: { requireAdult: true, roster: 'none', guestAccess } },
    id,
  );

const registry = new ConfigRegistry([survey('guest-pilot', true), survey('cas-only', false)]);
const pools = createPools(appEnv);
const llm = new LlmMonitor(new MockClient(), { probe: mockProbe() });
const silent = { info() {}, warn() {}, error() {} };
const app = buildApp({
  env: appEnv,
  registry,
  pools,
  engine: new SessionEngine(pools.survey, registry, llm, silent),
  log: silent,
  llmName: 'mock',
  llmStatus: () => llm.status(),
} satisfies AppContext);

const ORIGIN = 'http://127.0.0.1';
const get = (path: string, cookie?: string) =>
  app.request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : undefined);

async function guestCookie(): Promise<string> {
  const res = await get(`/survey/auth/invite?t=${encodeURIComponent(mintInvite(appEnv, 'guest-pilot', soon()))}`);
  assert.equal(res.status, 302);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'invite sets a session cookie');
  return setCookie.split(';')[0]!;
}

test('a valid invite signs the visitor in and drops them on that survey', async () => {
  const res = await get(`/survey/auth/invite?t=${encodeURIComponent(mintInvite(appEnv, 'guest-pilot', soon()))}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/survey/s/guest-pilot');
});

test('an invite is refused for a survey that has not opted into guests', async () => {
  const res = await get(`/survey/auth/invite?t=${encodeURIComponent(mintInvite(appEnv, 'cas-only', soon()))}`);
  assert.equal(res.status, 404);
});

test('a forged or expired invite gets no session', async () => {
  for (const t of ['nonsense', mintInvite(other, 'guest-pilot', soon()), mintInvite(appEnv, 'guest-pilot', new Date(0))]) {
    const res = await get(`/survey/auth/invite?t=${encodeURIComponent(t)}`);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie is issued');
  }
});

test('a guest cannot see a CAS-only survey at all', async () => {
  const res = await get('/survey/api/s/cas-only/state', await guestCookie());
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, 'no_survey');
});

test('a guest gets no admin surface', async () => {
  const cookie = await guestCookie();
  const list = await get('/survey/api/admin/surveys', cookie);
  assert.equal(list.status, 200);
  assert.deepEqual(((await list.json()) as { surveys: unknown[] }).surveys, [], 'no survey is administrable by a guest');
  for (const path of ['/survey/api/admin/s/cas-only/sessions', '/survey/api/admin/s/guest-pilot/sessions']) {
    const res = await get(path, cookie);
    assert.equal(res.status, 404, `${path} is invisible to a guest`);
  }
});
