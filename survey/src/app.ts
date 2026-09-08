/**
 * Shared request plumbing: the app context handed to every route module,
 * identity middleware, CSRF/rate-limit guards, and the JSON error shape.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';
import { loginUrl, readIdentity, safeNext } from './auth/cas.js';
import type { ConfigRegistry } from './config/load.js';
import type { Pools } from './db/pools.js';
import type { Logger, SessionEngine } from './engine/session.js';
import type { Env } from './env.js';
import type { LlmStatus } from './llm/monitor.js';

export interface AppContext {
  env: Env;
  registry: ConfigRegistry;
  pools: Pools;
  engine: SessionEngine;
  log: Logger;
  llmName: string;
  llmStatus: () => LlmStatus;
}

export type AppEnv = { Variables: { pid: string } };
export type App = Hono<AppEnv>;
export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** API routes: 401 JSON with a login URL the client can follow. */
export function requireApiIdentity(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = await readIdentity(c, ctx.env);
    if (!id) {
      const next_ = safeNext(ctx.env, c.req.header('x-survey-page'));
      return c.json({ error: 'unauthenticated', login: loginUrl(ctx.env, next_) }, 401);
    }
    c.set('pid', id.pid);
    await next();
  };
}

/** Page routes that need a signed-in user: bounce through CAS and come back. */
export function requirePageIdentity(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = await readIdentity(c, ctx.env);
    if (!id) return c.redirect(loginUrl(ctx.env, safeNext(ctx.env, new URL(c.req.url).pathname)), 302);
    c.set('pid', id.pid);
    await next();
  };
}

/**
 * CSRF posture for JSON APIs: the cookie is SameSite=Lax, every mutating call
 * must carry a custom header (which forces a CORS preflight cross-origin —
 * and we serve no CORS headers), and any Origin present must be our own.
 */
export function csrfGuard(env: Env): MiddlewareHandler<AppEnv> {
  const ownOrigin = new URL(env.BASE_URL).origin;
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (c.req.header('x-requested-with') !== 'fetch') {
        return c.json({ error: 'csrf', message: 'Missing X-Requested-With header' }, 403);
      }
      const origin = c.req.header('origin');
      if (origin && origin !== ownOrigin) return c.json({ error: 'csrf', message: 'Bad origin' }, 403);
    }
    await next();
  };
}

/** Small in-memory token bucket per PID (falls back to IP before sign-in). */
export function rateLimit(perMinute: number): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return async (c, next) => {
    const key = c.get('pid') ?? c.req.header('x-real-ip') ?? 'anon';
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return c.json({ error: 'rate_limited', message: 'Too many requests; slow down a little.' }, 429);
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    await next();
  };
}

export async function readJson<T>(c: Ctx, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_body', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
    // The protocol promises no third-party services; the browser enforces it too.
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; form-action 'self' https://login.vt.edu; base-uri 'self'",
    );
  };
}
