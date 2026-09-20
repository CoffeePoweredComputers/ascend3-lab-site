/** Assemble the Hono app from a ready AppContext (shared by server.ts and the e2e test). */
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrfGuard, HttpError, requireApiIdentity, securityHeaders, type AppContext, type AppEnv } from './app.js';
import { pingPools } from './db/pools.js';
import { SessionError } from './engine/session.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { pageRoutes } from './routes/pages.js';
import { participantRoutes } from './routes/participant.js';

export function buildApp(ctx: AppContext): Hono<AppEnv> {
  const { env, registry, pools, log } = ctx;
  const app = new Hono<AppEnv>().basePath(env.basePath || '/');

  app.use('*', securityHeaders());
  // Participant bodies are one answer (≤ 20 000 chars). Admin bodies carry a whole
  // survey definition (consent sheet + prompt); 64 KB matches nginx's client_max_body_size
  // for /survey/, so the app's own 413 is the one the browser sees.
  const tooLarge = (c: Context) => c.json({ error: 'too_large', message: 'Request too large' }, 413);
  const participantBody = bodyLimit({ maxSize: 32 * 1024, onError: tooLarge });
  const adminBody = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  app.use('/api/*', (c, next) => (c.req.path.includes('/api/admin/') ? adminBody : participantBody)(c, next));
  app.use('/api/*', csrfGuard(env));

  app.get('/healthz', async (c) => {
    const db = await pingPools(pools);
    const ok = db.survey && db.keyring;
    const llm = ctx.llmStatus();
    return c.json({ ok, db, surveys: registry.list().length, llm: { provider: llm.provider, state: llm.state } }, ok ? 200 : 503);
  });

  // Any signed-in user may read the model light (participants see a short label, admins the detail).
  app.get('/api/llm-status', requireApiIdentity(ctx), (c) => c.json(ctx.llmStatus()));

  app.route('/auth', authRoutes(ctx));
  app.route('/api/admin', adminRoutes(ctx));
  app.route('/api', participantRoutes(ctx));
  app.route('/', pageRoutes(ctx));

  const prefix = env.basePath;
  app.use(
    '/*',
    serveStatic({
      root: env.WEB_DIR,
      rewriteRequestPath: (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p),
      onFound: (_path, c) => c.header('Cache-Control', env.isProduction ? 'public, max-age=300' : 'no-store'),
    }),
  );

  app.notFound((c) => (c.req.path.includes('/api/') ? c.json({ error: 'not_found' }, 404) : c.text('Not found', 404)));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, err.status as 400);
    if (err instanceof SessionError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    log.error('unhandled', { path: c.req.path, method: c.req.method, message: err.message.slice(0, 300) });
    return c.json({ error: 'internal', message: 'Something went wrong on our side. Please try again.' }, 500);
  });

  return app;
}
