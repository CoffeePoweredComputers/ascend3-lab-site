/**
 * Lab tools gate: the only thing between nginx and a tool.
 *
 * nginx sends every /tools/<name>/ request through `auth_request` to /check,
 * which answers 200 plus `X-Tool-Port` (the loopback port that tool is on)
 * or 401/403. Because the port comes from this service, adding a tool needs
 * no nginx edit and no reload. Which tools are live, and who may open each,
 * comes from the status.json the runner (tools/_lib/deploy.mjs) writes.
 *
 * Two kinds of people get a cookie, both by their OWN Firebase ID token:
 *
 *  - members: members/{uid}.status == "member" in Firestore, i.e. approved by
 *    an admin. They may open any tool.
 *  - participants: any verified @vt.edu sign-in, but only for a tool whose
 *    tool.json says access: "participants", and only until that tool's
 *    participantsUntil date (end of that day, Eastern). The participant role
 *    is assigned here at sign-in, never by an admin. Two Firestore records
 *    are written with the user's own token, so the rules bound them:
 *      participants/<tool>_<uid>    carries expiresAt; a Firestore TTL policy
 *                                   deletes it after the study ends
 *      participations/<tool>_<uid>  kept: who took part in which study, with
 *                                   first and last sign-in
 *
 * The token is verified against Google's public keys and Firestore is read
 * and written through its REST API as the user. No Admin SDK, no
 * service-account key on the server. The cookie is signed, scoped to /tools,
 * good for 24 h; that is also the revocation bound for a removed member.
 *
 * On every tool request, /check tells nginx who is asking (X-Tool-User,
 * X-Tool-Uid, X-Tool-Role) and nginx forwards those headers to the tool.
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
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

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

/** ms at the end (23:59:59) of a YYYY-MM-DD day in America/New_York. */
function endOfDayEastern(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess))
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = Number(name.replace('GMT', '')) || -5; // "GMT-4" in summer, "GMT-5" in winter
  return guess - offsetHours * 3_600_000;
}

/** A tool currently admitting participants: declared so, and its end date not passed. */
function participantsOpen(t) {
  return Boolean(t && t.access === 'participants' && t.participantsUntil && Date.now() < endOfDayEastern(t.participantsUntil));
}

// ── Firestore REST, as the user ──────────────────────────────────────────────
const S = (v) => ({ stringValue: v });
const T = (iso) => ({ timestampValue: iso });

async function fsFetch(url, idToken, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
}

/** Firestore, as the user: 200 with status "member" is the only yes. */
async function isApprovedMember(uid, idToken) {
  const r = await fsFetch(`${FIRESTORE}/members/${encodeURIComponent(uid)}`, idToken);
  if (!r || r.status !== 200) return false;
  try {
    const doc = await r.json();
    return doc?.fields?.status?.stringValue === 'member';
  } catch {
    return false;
  }
}

/** Create a document, or if it already exists update only `updatable` fields. */
async function upsert(collection, id, idToken, fields, updatable) {
  const doc = `${FIRESTORE}/${collection}/${encodeURIComponent(id)}`;
  const created = await fsFetch(`${doc}?currentDocument.exists=false`, idToken, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  });
  if (created?.ok) return true;
  const mask = updatable.map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const subset = Object.fromEntries(updatable.map((f) => [f, fields[f]]));
  const updated = await fsFetch(`${doc}?${mask}&currentDocument.exists=true`, idToken, {
    method: 'PATCH',
    body: JSON.stringify({ fields: subset }),
  });
  return Boolean(updated?.ok);
}

/** The two records behind a participant sign-in. Both must succeed. */
async function recordParticipation(tool, uid, email, until, idToken) {
  const id = `${tool}_${uid}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(endOfDayEastern(until)).toISOString();
  const kept = await upsert(
    'participations', id, idToken,
    { uid: S(uid), email: S(email), tool: S(tool), firstLoginAt: T(now), lastLoginAt: T(now), participantsUntil: S(until) },
    ['lastLoginAt'],
  );
  const active = await upsert(
    'participants', id, idToken,
    { uid: S(uid), email: S(email), tool: S(tool), createdAt: T(now), lastLoginAt: T(now), expiresAt: T(expiresAt) },
    ['lastLoginAt', 'expiresAt'],
  );
  return kept && active;
}

// ── Cookie ───────────────────────────────────────────────────────────────────
/** The person behind the cookie ({ sub, email, role, tools? }), or null. */
async function person(c) {
  const jwt = getCookie(c, COOKIE);
  if (!jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, SECRET, { algorithms: ['HS256'], issuer: COOKIE_ISSUER });
    return { ...payload, role: payload.role ?? 'member' };
  } catch {
    return null;
  }
}

async function mint(c, { uid, email, role, tools }) {
  const jwt = await new SignJWT({ email, role, ...(tools ? { tools } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(uid)
    .setIssuer(COOKIE_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL_S}s`)
    .sign(SECRET);
  setCookie(c, COOKIE, jwt, {
    path: '/tools',
    httpOnly: true,
    secure: process.env.COOKIE_INSECURE !== '1',
    sameSite: 'Lax',
    maxAge: COOKIE_TTL_S,
  });
}

/** Verified, vt.edu-checked claims of a Firebase ID token, or null. */
async function verifyIdToken(idToken) {
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, JWKS, {
      algorithms: ['RS256'],
      audience: PROJECT,
      issuer: `https://securetoken.google.com/${PROJECT}`,
      clockTolerance: 60,
    }));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const ok =
    claims.sub &&
    claims.email_verified === true &&
    typeof claims.email === 'string' &&
    claims.email.toLowerCase().endsWith('@vt.edu') &&
    !(typeof claims.auth_time === 'number' && claims.auth_time > now + 60);
  return ok ? { uid: claims.sub, email: claims.email } : null;
}

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

/**
 * Exchange a Firebase ID token for the cookie. Body: { idToken, tool? }.
 * Members get a member cookie whatever `tool` says. Anyone else gets a
 * participant cookie for `tool` if that tool is open to participants.
 */
app.post('/session', async (c) => {
  // Login-CSRF guard: only the wiki page may mint. Sec-Fetch-Site is the
  // reliable signal; older Safari lacks it, so fall back to Origin equality,
  // never to "allow".
  const sfs = c.req.header('sec-fetch-site');
  const sameOrigin = sfs ? sfs === 'same-origin' : c.req.header('origin') === SITE_ORIGIN;
  if (!sameOrigin) return c.json({ error: 'cross-site request' }, 403);

  let body = {};
  try {
    body = await c.req.json();
  } catch {
    /* fallthrough */
  }
  const { idToken, tool } = body ?? {};
  if (typeof idToken !== 'string' || !idToken) return c.json({ error: 'idToken required' }, 400);

  const who = await verifyIdToken(idToken);
  if (!who) return c.json({ error: 'invalid token or not a verified vt.edu account' }, 401);

  if (await isApprovedMember(who.uid, idToken)) {
    await mint(c, { ...who, role: 'member' });
    console.log(`gate: member session for ${who.email}`);
    return c.json({ ok: true, role: 'member', email: who.email });
  }

  const name = typeof tool === 'string' && TOOL_RE.test(tool) ? tool : null;
  const t = name ? status().tools[name] : null;
  if (!t || t.access !== 'participants') {
    console.log(`gate: refused ${who.email} (not an approved member)`);
    return c.json({ error: 'not an approved member', reason: 'members-only' }, 403);
  }
  if (!participantsOpen(t)) {
    return c.json({ error: 'this study is closed', reason: 'closed', until: t.participantsUntil }, 403);
  }
  if (!(await recordParticipation(name, who.uid, who.email, t.participantsUntil, idToken))) {
    console.error(`gate: could not record participation of ${who.email} in ${name}`);
    return c.json({ error: 'could not record your participation; try again' }, 502);
  }
  const prior = await person(c);
  const tools = [...new Set([...(prior?.role === 'participant' ? prior.tools ?? [] : []), name])];
  await mint(c, { ...who, role: 'participant', tools });
  console.log(`gate: participant session for ${who.email} in ${name}`);
  return c.json({ ok: true, role: 'participant', email: who.email, until: t.participantsUntil });
});

/** nginx auth_request target. 200 + X-Tool-Port routes; 401 sends the browser
 *  to the wiki page to sign in; 403 is "no such tool / not live" and must stay
 *  403 (a 401 there would loop through the sign-in bounce forever). */
app.get('/check', async (c) => {
  const p = await person(c);
  if (!p) return c.body(null, 401);
  const name = c.req.header('x-tool') ?? '';
  if (!TOOL_RE.test(name)) return c.body(null, 403);
  const t = status().tools[name];
  if (!t?.live || !Number.isInteger(t.port)) return c.body(null, 403);
  if (p.role === 'participant' && (!p.tools?.includes(name) || !participantsOpen(t))) {
    return c.body(null, 401);   // a participant on a tool they are not in, or a study that has ended: re-sign-in decides
  }
  c.header('X-Tool-Port', String(t.port));
  c.header('X-Tool-User', String(p.email ?? ''));
  c.header('X-Tool-Uid', String(p.sub ?? ''));
  c.header('X-Tool-Role', p.role);
  return c.body(null, 200);
});

/** What the last deploy did to each tool: the no-SSH answer to "did my merge work?". */
app.get('/status', async (c) => {
  const p = await person(c);
  if (!p || p.role !== 'member') return c.json({ error: 'sign in on /wiki/lab-tools first' }, 401);
  return c.json(status());
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`gate: listening on ${info.port}, status from ${STATUS_PATH}`);
});
