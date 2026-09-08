/**
 * Time candidate models against the REAL probe prompt of a survey.
 *
 *   npm run bench:model -- [--survey irb-26-817] [--runs 3] [--effort low] model1 model2 …
 *
 * Builds the same messages the engine sends (system prompt + a sample starter
 * exchange), calls ARC for each candidate `runs` times, and prints latency,
 * completion tokens, finish reason, and whether the reply parsed as a probe /
 * MOVE_ON. Uses ARC_LLM_API_KEY from survey/.env; nothing is written to the DB.
 */
import { loadSurveyDir } from '../src/config/load.js';
import { buildMessages } from '../src/engine/prompt.js';
import { extractContent, extractFinishReason, parseModelOutput } from '../src/engine/parse.js';
import type { TurnRow } from '../src/engine/types.js';
import { loadEnv } from '../src/env.js';
import { ArcClient } from '../src/llm/arc.js';

const args = process.argv.slice(2);
function opt(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) {
    const v = args[i + 1]!;
    args.splice(i, 2);
    return v;
  }
  return dflt;
}
const surveyId = opt('survey', 'irb-26-817');
const runs = Number(opt('runs', '3'));
const effort = opt('effort', '') as '' | 'low' | 'medium' | 'high';
const models = args.length ? args : ['gpt-oss-120b'];

const env = loadEnv();
if (!env.ARC_LLM_API_KEY) throw new Error('ARC_LLM_API_KEY is not set in survey/.env');
const survey = loadSurveyDir(env.SURVEYS_DIR).find((s) => s.config.id === surveyId);
if (!survey) throw new Error(`no survey ${surveyId}`);
const cfg = survey.config;
const starter = cfg.waves[0]!.starters[0]!;
const turns: TurnRow[] = [
  { seq: 1, kind: 'starter', starterIndex: 0, starterId: starter.id, probeIndex: 0, probeType: null, trigger: null, text: starter.text, flags: {}, llmCallId: null },
  {
    seq: 2, kind: 'answer', starterIndex: 0, starterId: starter.id, probeIndex: 0, probeType: null, trigger: null, flags: {}, llmCallId: null,
    text: 'Usually we would just split the work up at the start and figure it out as we went. It was fine mostly, a bit unclear on the doc.',
  },
];
const messages = buildMessages(cfg, starter, turns, 0, cfg.probing.maxProbesPerStarter);
const client = new ArcClient(env.ARC_LLM_BASE_URL, env.ARC_LLM_API_KEY);
const parseOpts = { probeTypes: cfg.probing.probeTypes, moveOnToken: cfg.probing.moveOnToken, maxQuestionWords: cfg.probing.maxQuestionWords };

(async () => {
  console.log(`survey ${surveyId} · prompt ≈ ${messages.map((m) => m.content.length).reduce((a, b) => a + b, 0)} chars · runs=${runs}${effort ? ` · reasoning_effort=${effort}` : ''}\n`);
  for (const model of models) {
    const lat: number[] = [];
    let ok = 0;
    let lastReply = '';
    let lastTokens = '';
    for (let i = 0; i < runs; i++) {
      try {
        const res = await client.complete({
          model,
          messages,
          temperature: cfg.model.temperature,
          maxTokens: cfg.model.maxTokens,
          timeoutMs: cfg.model.timeoutMs,
          ...(effort ? { reasoningEffort: effort } : {}),
        });
        lat.push(res.latencyMs);
        const body = res.body as { usage?: { completion_tokens?: number } };
        const parsed = parseModelOutput(extractContent(res.body), parseOpts);
        if (parsed.kind !== 'parse_error') ok++;
        lastTokens = `${body.usage?.completion_tokens ?? '?'} tok, finish=${extractFinishReason(res.body) ?? '?'}`;
        lastReply = parsed.kind === 'probe' ? `${parsed.probeType}: ${parsed.question}` : parsed.kind === 'move_on' ? 'MOVE_ON' : `PARSE_ERROR (${parsed.reason})`;
      } catch (e) {
        lat.push(-1);
        lastReply = `ERROR ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
      }
    }
    const good = lat.filter((l) => l >= 0);
    const avg = good.length ? Math.round(good.reduce((a, b) => a + b, 0) / good.length) : NaN;
    console.log(`${model.padEnd(34)} avg ${String(avg).padStart(5)} ms  (${good.map((l) => l).join('/')} ms)  parsed ${ok}/${runs}  ${lastTokens}`);
    console.log(`  ↳ ${lastReply}\n`);
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
