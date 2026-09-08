/**
 * Sign-in routes (mounted at /auth).
 *
 *   GET  /login?next=      → CAS
 *   GET  /callback?ticket  ← CAS; validates, sets the session cookie, redirects to `next`
 *   POST /logout           clears our cookie (the page offers the CAS-wide logout link)
 *   GET  /dev-login?pid=   local development only (see env.ts guards)
 *   GET  /invite?t=        signed guest link for pilot surveys (see auth/guest.ts)
 */
import { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { CasError, casLogoutUrl, clearIdentity, loginUrl, readIdentity, safeNext, setIdentity, validateTicket } from '../auth/cas.js';
import { newGuestPid, verifyInvite } from '../auth/guest.js';

export function authRoutes(ctx: AppContext): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { env } = ctx;

  r.get('/login', (c) => c.redirect(loginUrl(env, safeNext(env, c.req.query('next'))), 302));

  r.get('/callback', async (c) => {
    const next = safeNext(env, c.req.query('next'));
    const ticket = c.req.query('ticket');
    if (!ticket) return c.redirect(loginUrl(env, next), 302);
    try {
      const pid = await validateTicket(env, ticket, next);
      await setIdentity(c, env, pid);
      ctx.log.info('auth.login', { ok: true });
      return c.redirect(next, 302);
    } catch (e) {
      const reason = e instanceof CasError ? e.message : 'validation error';
      ctx.log.warn('auth.login', { ok: false, reason });
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><link rel="stylesheet" href="${env.basePath}/style.css">
         <main class="page page--narrow"><h1>Sign-in didn't complete</h1>
         <p>Virginia Tech Login didn't confirm your session (${escapeHtml(reason)}). This usually means the link was reused or timed out.</p>
         <p><a class="btn btn--primary" href="${env.basePath}/auth/login?next=${encodeURIComponent(next)}">Try again</a></p></main>`,
        401,
      );
    }
  });

  r.post('/logout', (c) => {
    clearIdentity(c, env);
    return c.redirect(`${env.basePath}/?signedout=1`, 302);
  });

  r.get('/cas-logout', (c) => {
    clearIdentity(c, env);
    return c.redirect(casLogoutUrl(env), 302);
  });

  /**
   * Guest entry for a pilot survey. Only the survey named inside the signed
   * token is reachable, and only while its file sets eligibility.guestAccess.
   * An existing session (CAS or guest) is left alone, so reopening the link
   * resumes rather than restarting as somebody new.
   */
  r.get('/invite', async (c) => {
    const surveyId = verifyInvite(env, c.req.query('t') ?? '');
    if (!surveyId) return c.text('This invite link is invalid or has expired.', 403);
    const loaded = ctx.registry.get(surveyId);
    if (!loaded?.config.eligibility.guestAccess) return c.notFound();
    if (!(await readIdentity(c, env))) {
      await setIdentity(c, env, newGuestPid());
      ctx.log.info('auth.guest', { surveyId });
    }
    return c.redirect(safeNext(env, `${env.basePath}/s/${surveyId}`), 302);
  });

  r.get('/dev-login', async (c) => {
    const host = new URL(c.req.url).hostname;
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (env.isProduction || !env.DEV_LOGIN_ENABLED || !loopback) return c.notFound();
    const pid = (c.req.query('pid') ?? '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(pid)) return c.text('pid required, e.g. ?pid=test1', 400);
    await setIdentity(c, env, pid);
    return c.redirect(safeNext(env, c.req.query('next')), 302);
  });

  return r;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
