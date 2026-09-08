/** Provider-neutral completion interface. `arc` is the only provider permitted in production. */
import type { Env } from '../env.js';
import type { ChatMessage } from '../engine/prompt.js';
import { ArcClient } from './arc.js';
import { log } from '../log.js';
import { MockClient } from './mock.js';

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Not sent to any provider; lets the offline mock produce taxonomy-valid probes. */
  hints?: { probeTypes: string[]; moveOnToken: string };
}

export interface CompletionResult {
  /** Raw provider response body (stored verbatim in survey.llm_calls.response). */
  body: unknown;
  latencyMs: number;
}

export interface LlmClient {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export function createLlmClient(env: Env): LlmClient {
  if (env.LLM_PROVIDER === 'mock') return new MockClient();
  return new ArcClient(env.ARC_LLM_BASE_URL, env.ARC_LLM_API_KEY, (info) => log.warn('llm.retry', { ...info }));
}
