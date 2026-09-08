/**
 * Virginia Tech ARC on-premises LLM API (llm-api.arc.vt.edu), OpenAI-compatible.
 *
 * `POST {base}/chat/completions` with `Authorization: Bearer <personal key>`.
 * Non-streaming. One retry on transport errors, 429 and 5xx. The caller owns
 * the timeout budget; we never log request or response content here.
 */
import type { CompletionRequest, CompletionResult, LlmClient } from './index.js';

export interface RetryInfo {
  attempt: number;
  status: number | null;
  error: string;
  elapsedMs: number;
}

export class ArcClient implements LlmClient {
  readonly name = 'arc';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly onRetry: (info: RetryInfo) => void = () => {},
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const deadline = started + req.timeoutMs;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 500) break;
      try {
        const body = await this.once(req, remaining);
        return { body, latencyMs: Date.now() - started };
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt === 1) break;
        this.onRetry({
          attempt: attempt + 1,
          status: (e as { status?: number } | null)?.status ?? null,
          error: e instanceof Error ? e.message.slice(0, 160) : String(e),
          elapsedMs: Date.now() - started,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async once(req: CompletionRequest, timeoutMs: number): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream: false,
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`ARC ${res.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('ARC returned non-JSON body');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (status !== undefined) return false;
  // AbortError (timeout) is not retried — the budget is spent. Other transport errors are.
  return !(e instanceof Error && e.name === 'AbortError');
}
