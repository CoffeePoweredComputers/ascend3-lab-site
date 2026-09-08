/**
 * HTML shells. The participant page and the admin page are static files in
 * `web/` with two placeholders filled at request time; all state comes from
 * the API. The information sheet is rendered server-side so it prints cleanly.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { requirePageIdentity, type AppContext, type AppEnv } from '../app.js';
import { hasAnyRole } from '../auth/roles.js';

export function pageRoutes(ctx: AppContext): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { env } = ctx;
  const webDir = resolve(env.WEB_DIR);
  const cache = new Map<string, string>();

  function shell(name: string, vars: Record<string, string>): string {
    let html = cache.get(name);
    if (!html || !env.isProduction) {
      html = readFileSync(join(webDir, name), 'utf8');
      cache.set(name, html);
    }
    return html.replace(/__BASE__/g, env.basePath).replace(/__SURVEY_ID__/g, escapeAttr(vars.surveyId ?? ''));
  }

  r.get('/', (c) => c.html(shell('index.html', { surveyId: '' })));

  r.get('/s/:surveyId', (c) => {
    const id = c.req.param('surveyId');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !ctx.registry.get(id)) return c.notFound();
    return c.html(shell('index.html', { surveyId: id }));
  });

  r.get('/s/:surveyId/info-sheet', requirePageIdentity(ctx), (c) => {
    const id = c.req.param('surveyId');
    const loaded = ctx.registry.get(id);
    if (!loaded) return c.notFound();
    if (loaded.config.status === 'draft' && !hasAnyRole(loaded.config, c.get('pid'))) return c.notFound();
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Information sheet — ${escapeHtml(loaded.config.title)}</title><link rel="stylesheet" href="${env.basePath}/style.css"></head>
<body><main class="page sheet"><nav class="sheet__nav no-print"><a href="${env.basePath}/s/${id}">← Back to the survey</a>
<button type="button" class="btn" data-print>Print / save as PDF</button></nav>
<article class="prose">${loaded.sheetHtml}</article>
<p class="sheet__version no-print">Configuration version ${loaded.version.slice(0, 12)}</p></main>
<script src="${env.basePath}/sheet.js"></script></body></html>`,
    );
  });

  r.get('/admin', (c) => c.html(shell('admin.html', {})));

  return r;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
