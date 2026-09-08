/**
 * ASCEND adaptive survey service — entry point.
 *
 * Boot order: env → survey files (fail loud) → database pools → snapshot
 * config versions → LLM client → HTTP app on 127.0.0.1:$PORT under $BASE_URL's
 * path. nginx terminates TLS and proxies `/survey/` here. See README.md.
 */
import { serve } from '@hono/node-server';
import type { AppContext } from './app.js';
import { buildApp } from './build.js';
import { ConfigRegistry, loadSurveyDir } from './config/load.js';
import { closePools, createPools } from './db/pools.js';
import { SessionEngine } from './engine/session.js';
import { loadEnv } from './env.js';
import { createLlmClient } from './llm/index.js';
import { arcProbe, LlmMonitor, mockProbe } from './llm/monitor.js';
import { log } from './log.js';
import { snapshotConfigs } from './store/survey.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const surveys = loadSurveyDir(env.SURVEYS_DIR);
  const registry = new ConfigRegistry(surveys);
  const pools = createPools(env);
  const snap = await snapshotConfigs(pools.survey, registry);
  const llm = new LlmMonitor(createLlmClient(env), {
    probe: env.LLM_PROVIDER === 'mock' ? mockProbe() : arcProbe(env.ARC_LLM_BASE_URL, env.ARC_LLM_API_KEY),
  });
  llm.start();
  const engine = new SessionEngine(pools.survey, registry, llm, log);
  const ctx: AppContext = { env, registry, pools, engine, log, llmName: llm.name, llmStatus: () => llm.status() };
  const app = buildApp(ctx);

  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '127.0.0.1' }, (info) => {
    log.info('server.listening', {
      port: info.port,
      basePath: env.basePath,
      surveys: registry.list().map((s) => `${s.config.id}@${s.version.slice(0, 12)}`),
      configSnapshots: snap,
      llm: llm.name,
      env: env.NODE_ENV,
    });
  });

  const shutdown = (signal: string) => {
    log.info('server.shutdown', { signal });
    llm.stop();
    server.close(async (err) => {
      if (err) log.error('server.close_error', { message: err.message });
      await closePools(pools);
      process.exit(err ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
