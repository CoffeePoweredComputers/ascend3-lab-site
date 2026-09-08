/**
 * Typed process configuration.
 *
 * Reads `survey/.env` (KEY=VALUE lines; `#` comments; optional single/double
 * quotes) and merges it UNDER the real process environment, so a systemd
 * `EnvironmentFile=` or an inline `LLM_PROVIDER=mock npm run dev` always wins.
 * Parsed by hand on purpose: the server's Node version is not pinned, so we
 * rely on neither `dotenv` nor `node --env-file`.
 *
 * Boot aborts with one readable message listing every missing/invalid value
 * rather than failing on the first one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export type LlmProvider = 'arc' | 'mock';

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  BASE_URL: z.string().url().transform((s) => s.replace(/\/+$/, '')),
  CAS_BASE_URL: z.string().url().transform((s) => s.replace(/\/+$/, '')),
  SESSION_SECRET: z.string().min(1),
  LLM_PROVIDER: z.enum(['arc', 'mock']).default('arc'),
  ARC_LLM_BASE_URL: z
    .string()
    .url()
    .default('https://llm-api.arc.vt.edu/api/v1')
    .transform((s) => s.replace(/\/+$/, '')),
  ARC_LLM_API_KEY: z.string().default(''),
  SURVEY_DATABASE_URL: z.string().min(1),
  KEYRING_DATABASE_URL: z.string().min(1),
  MIGRATE_DATABASE_URL: z.string().default(''),
  DEV_LOGIN_ENABLED: z
    .string()
    .default('0')
    .transform((s) => s === '1' || s.toLowerCase() === 'true'),
  SURVEYS_DIR: z.string().default('surveys'),
  WEB_DIR: z.string().default('web'),
});

export type Env = z.infer<typeof schema> & {
  /** Path prefix the app is mounted at, derived from BASE_URL (e.g. "/survey"). */
  basePath: string;
  isProduction: boolean;
};

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(cwd = process.cwd()): Env {
  const file = resolve(cwd, '.env');
  const fromFile = existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {};
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;

  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment (checked ${file}):\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  const problems: string[] = [];
  if (env.LLM_PROVIDER === 'arc' && !env.ARC_LLM_API_KEY) problems.push('ARC_LLM_API_KEY is required when LLM_PROVIDER=arc');
  if (isProduction && env.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be at least 32 characters in production');
  if (isProduction && env.LLM_PROVIDER === 'mock') problems.push('LLM_PROVIDER=mock is not allowed in production');
  if (isProduction && env.DEV_LOGIN_ENABLED) problems.push('DEV_LOGIN_ENABLED must be off in production');
  if (problems.length) throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);

  const basePath = new URL(env.BASE_URL).pathname.replace(/\/+$/, '') || '';
  return { ...env, basePath, isProduction };
}
