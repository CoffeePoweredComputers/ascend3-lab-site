/**
 * Virginia Tech CAS (login.vt.edu) — the "VT single sign-on" the protocol names.
 *
 * Flow: redirect to `${CAS}/login?service=<callback>`; CAS returns to the
 * callback with `?ticket=ST-…`; we validate it server-side at
 * `${CAS}/serviceValidate` (CAS v2 XML) and read `uupid` (the PID). The
 * `service` URL must be byte-identical in both requests, so `next` travels
 * inside it. No service registration is needed for *.vt.edu hosts.
 *
 * The session is a signed cookie {pid, iat}; 12 hours; path-scoped to the app.
 */
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import type { Env } from '../env.js';

export const COOKIE = 'ascend_survey_session';
const SESSION_TTL_S = 12 * 60 * 60;

export interface Identity {
  pid: string;
  iat: number;
}

/** Only relative paths inside the app are acceptable redirect targets. */
export function safeNext(env: Env, next: string | undefined): string {
  const home = `${env.basePath}/`;
  if (!next) return home;
  if (!next.startsWith(home) && next !== env.basePath) return home;
  if (next.includes('//') || next.includes('\\') || /[\r\n]/.test(next)) return home;
  return next;
}

export function serviceUrl(env: Env, next: string): string {
  return `${env.BASE_URL}/auth/callback?next=${encodeURIComponent(next)}`;
}

export function loginUrl(env: Env, next: string): string {
  return `${env.CAS_BASE_URL}/login?service=${encodeURIComponent(serviceUrl(env, next))}`;
}

export function casLogoutUrl(env: Env): string {
  return `${env.CAS_BASE_URL}/logout?service=${encodeURIComponent(`${env.BASE_URL}/`)}`;
}

export class CasError extends Error {}

/** Validate a service ticket and return the PID. */
export async function validateTicket(env: Env, ticket: string, next: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!/^ST-[\w.-]+$/.test(ticket)) throw new CasError('malformed ticket');
  const url = `${env.CAS_BASE_URL}/serviceValidate?service=${encodeURIComponent(serviceUrl(env, next))}&ticket=${encodeURIComponent(ticket)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let xml: string;
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/xml, text/xml' } });
    if (!res.ok) throw new CasError(`serviceValidate HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }
  return parseServiceResponse(xml);
}

/** CAS v2 XML → PID. Exported for tests. */
export function parseServiceResponse(xml: string): string {
  if (/<cas:authenticationFailure\b/i.test(xml)) {
    const code = /<cas:authenticationFailure[^>]*code="([^"]*)"/i.exec(xml)?.[1] ?? 'unknown';
    throw new CasError(`CAS authentication failure (${code})`);
  }
  if (!/<cas:authenticationSuccess\b/i.test(xml)) throw new CasError('unexpected CAS response');
  const uupid = /<cas:uupid>\s*([^<\s]+)\s*<\/cas:uupid>/i.exec(xml)?.[1];
  const user = /<cas:user>\s*([^<\s]+)\s*<\/cas:user>/i.exec(xml)?.[1];
  const pid = (uupid ?? user ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pid)) throw new CasError('CAS response had no usable PID');
  return pid;
}

export async function setIdentity(c: Context, env: Env, pid: string): Promise<void> {
  const value = JSON.stringify({ pid, iat: Math.floor(Date.now() / 1000) } satisfies Identity);
  await setSignedCookie(c, COOKIE, value, env.SESSION_SECRET, {
    path: env.basePath || '/',
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_S,
  });
}

export function clearIdentity(c: Context, env: Env): void {
  deleteCookie(c, COOKIE, { path: env.basePath || '/' });
}

export async function readIdentity(c: Context, env: Env): Promise<Identity | null> {
  const raw = await getSignedCookie(c, env.SESSION_SECRET, COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Identity>;
    if (typeof parsed.pid !== 'string' || typeof parsed.iat !== 'number') return null;
    if (Math.floor(Date.now() / 1000) - parsed.iat > SESSION_TTL_S) return null;
    return { pid: parsed.pid, iat: parsed.iat };
  } catch {
    return null;
  }
}
