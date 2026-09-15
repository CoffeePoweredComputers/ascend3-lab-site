/**
 * Lab tools gate: the only thing between nginx and a tool.
 *
 * nginx sends every /tools/<name>/ request through `auth_request` to /check,
 * which answers 200 plus `X-Tool-Port` (the loopback port that tool is on)
 * or 401/403. Because the port comes from this service, adding a tool needs
 * no nginx edit and no reload. The gate reads which tools are live from the
 * status.json the runner (tools/_lib/deploy.mjs) writes.
 *
 * Membership is decided with the user's OWN Firebase ID token and the
 * existing Firestore rules: the token is verified against Google's public
 * keys, then members/{uid} is read through the Firestore REST API as that
 * user (the rules allow self-read). No Admin SDK, no service-account key on
 * the server. The result is a signed cookie scoped to /tools, good for 24 h;
 * that is also the revocation bound when a member is removed.
 *
 * Env (from ~/.config/ascend-tools/_gate.env via the runner):
 *   TOOLS_COOKIE_SECRET   32+ random bytes, hex; signs the cookie
 *   FIREBASE_PROJECT_ID   ascend3-lab
 *   SITE_ORIGIN           https://ascend3.cs.vt.edu
 *   STATUS_PATH           /state/status.json (mounted read-only by the runner)
 *   COOKIE_INSECURE=1     local dev over plain http only; never on the server
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import fs from 'node:fs';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`gate: ${k} is not set`);
    process.exit(1);
  }
  return v;
};
const SECRET = new TextEncoder().encode(need('TOOLS_COOKIE_SECRET'));
const PROJECT = need('FIREBASE_PROJECT_ID');
const SITE_ORIGIN = need('SITE_ORIGIN');
const STATUS_PATH = process.env.STATUS_PATH ?? '/state/status.json';
const PORT = Number(process.env.PORT ?? 8080);
const COOKIE = 'ascend_tools';
const COOKIE_TTL_S = 24 * 3600;
const COOKIE_ISSUER = 'ascend-tools';
const TOOL_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

// ── status.json: re-read when its mtime changes; unreadable means "no tools" ──
let cache = { mtimeMs: -1, status: { tools: {} } };
function status() {
  try {
    const { mtimeMs } = fs.statSync(STATUS_PATH);
    if (mtimeMs !== cache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
      cache = { mtimeMs, status: { tools: {}, ...parsed } };
    }
  } catch {
    cache = { mtimeMs: -1, status: { tools: {} } };
  }
  return cache.status;
}

/** Firestore, as the user: 200 with status "member" is the only yes. */
async function isApprovedMember(uid, idToken) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/members/` +
    encodeURIComponent(uid);
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.status !== 200) return false;
    const doc = await r.json();
    return doc?.fields?.status?.stringValue === 'member';
  } catch {
    return false;
  }
}

/** The member behind the cookie, or null. */
async function member(c) {
  const jwt = getCookie(c, COOKIE);
  if (!jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, SECRET, { algorithms: ['HS256'], issuer: COOKIE_ISSUER });
    return payload;
  } catch {
    return null;
  }
}

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

app.post('/session', async (c) => {
  // Login-CSRF guard: only the wiki page may mint. Sec-Fetch-Site is the
  // reliable signal; older Safari lacks it, so fall back to Origin equality,
  // never to "allow".
  const sfs = c.req.header('sec-fetch-site');
  const sameOrigin = sfs ? sfs === 'same-origin' : c.req.header('origin') === SITE_ORIGIN;
  if (!sameOrigin) return c.json({ error: 'cross-site request' }, 403);

  let idToken;
  try {
    ({ idToken } = await c.req.json());
  } catch {
    /* fallthrough */
  }
  if (typeof idToken !== 'string' || !idToken) return c.json({ error: 'idToken required' }, 400);

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, JWKS, {
      algorithms: ['RS256'],
      audience: PROJECT,
      issuer: `https://securetoken.google.com/${PROJECT}`,
      clockTolerance: 60,
    }));
  } catch {
    return c.json({ error: 'invalid token' }, 401);
  }
  const uid = claims.sub;
  const email = claims.email;
  const now = Math.floor(Date.now() / 1000);
  if (
    !uid ||
    claims.email_verified !== true ||
    typeof email !== 'string' ||
    !email.toLowerCase().endsWith('@vt.edu') ||
    (typeof claims.auth_time === 'number' && claims.auth_time > now + 60)
  ) {
    return c.json({ error: 'not a verified vt.edu account' }, 403);
  }
  if (!(await isApprovedMember(uid, idToken))) {
    console.log(`gate: refused ${email} (not an approved member)`);
    return c.json({ error: 'not an approved member' }, 403);
  }

  const cookie = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(uid)
    .setIssuer(COOKIE_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL_S}s`)
    .sign(SECRET);
  setCookie(c, COOKIE, cookie, {
    path: '/tools',
    httpOnly: true,
    secure: process.env.COOKIE_INSECURE !== '1',
    sameSite: 'Lax',
    maxAge: COOKIE_TTL_S,
  });
  console.log(`gate: session for ${email}`);
  return c.json({ ok: true, email });
});

/** nginx auth_request target. 200 + X-Tool-Port routes; 401 sends the browser
 *  to the wiki page to sign in; 403 is "no such tool / not live" and must stay
 *  403 (a 401 there would loop through the sign-in bounce forever). */
app.get('/check', async (c) => {
  if (!(await member(c))) return c.body(null, 401);
  const name = c.req.header('x-tool') ?? '';
  if (!TOOL_RE.test(name)) return c.body(null, 403);
  const t = status().tools[name];
  if (!t?.live || !Number.isInteger(t.port)) return c.body(null, 403);
  c.header('X-Tool-Port', String(t.port));
  return c.body(null, 200);
});

/** What the last deploy did to each tool: the no-SSH answer to "did my merge work?". */
app.get('/status', async (c) => {
  if (!(await member(c))) return c.json({ error: 'sign in on /wiki/lab-tools first' }, 401);
  return c.json(status());
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`gate: listening on ${info.port}, status from ${STATUS_PATH}`);
});
