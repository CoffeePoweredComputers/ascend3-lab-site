/**
 * Model-connectivity monitor: the "is the LLM up?" light.
 *
 * Decorates an LlmClient so every real completion is recorded (ok/error,
 * latency), and runs a cheap background probe once a minute — for ARC a GET on
 * `/models` with the key, which confirms reachability AND that the key is still
 * accepted without spending tokens. `status()` folds both into one state:
 *
 *   down      the probe failed, or the last two real calls failed
 *   degraded  reachable, but the last call failed or was slow (> slowMs)
 *   unknown   nothing observed yet
 *   ok        otherwise
 *
 * A passing probe after real failures decays `down` to `degraded`; only a real
 * successful call gets back to `ok`. Never logs or stores request content.
 */
import type { CompletionRequest, CompletionResult, LlmClient } from './index.js';

export type LlmState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface LlmStatus {
  provider: string;
  model: string | null;
  state: LlmState;
  probe: { at: string | null; ms: number | null; error: string | null };
  lastCall: { at: string | null; ok: boolean | null; ms: number | null; error: string | null };
  consecutiveFailures: number;
}

export interface MonitorOptions {
  /** Resolves when the provider is reachable and the key is accepted; throws otherwise. */
  probe: () => Promise<void>;
  intervalMs?: number;
  slowMs?: number;
  now?: () => number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class LlmMonitor implements LlmClient {
  readonly name: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probeOk: boolean | null = null;
  private probeAt: number | null = null;
  private probeMs: number | null = null;
  private probeError: string | null = null;
  private callAt: number | null = null;
  private callOk: boolean | null = null;
  private callMs: number | null = null;
  private callError: string | null = null;
  private failures = 0;
  private model: string | null = null;

  constructor(
    private readonly inner: LlmClient,
    private readonly opts: MonitorOptions,
  ) {
    this.name = inner.name;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t = this.now();
    this.model = req.model;
    try {
      const res = await this.inner.complete(req);
      this.callAt = this.now();
      this.callOk = true;
      this.callMs = res.latencyMs;
      this.callError = null;
      this.failures = 0;
      return res;
    } catch (e) {
      this.callAt = this.now();
      this.callOk = false;
      this.callMs = this.now() - t;
      this.callError = errText(e);
      this.failures += 1;
      throw e;
    }
  }

  async runProbe(): Promise<void> {
    const t = this.now();
    try {
      await this.opts.probe();
      this.probeOk = true;
      this.probeError = null;
      if (this.failures > 1) this.failures = 1;
    } catch (e) {
      this.probeOk = false;
      this.probeError = errText(e);
    } finally {
      this.probeAt = this.now();
      this.probeMs = this.now() - t;
    }
  }

  start(): void {
    void this.runProbe();
    this.timer = setInterval(() => void this.runProbe(), this.opts.intervalMs ?? 60_000);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): LlmStatus {
    const slow = this.opts.slowMs ?? 10_000;
    let state: LlmState;
    if (this.probeOk === false || this.failures >= 2) state = 'down';
    else if (this.probeOk === null && this.callOk === null) state = 'unknown';
    else if (this.callOk === false || (this.callOk === true && this.callMs !== null && this.callMs > slow)) state = 'degraded';
    else state = 'ok';
    const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
    return {
      provider: this.name,
      model: this.model,
      state,
      probe: { at: iso(this.probeAt), ms: this.probeMs, error: this.probeError },
      lastCall: { at: iso(this.callAt), ok: this.callOk, ms: this.callMs, error: this.callError },
      consecutiveFailures: this.failures,
    };
  }
}

/** ARC: list models with the key. 5 s timeout. Throws with the HTTP status on failure. */
export function arcProbe(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): () => Promise<void> {
  return async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const res = await fetchImpl(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ARC ${res.status}: ${(await res.text()).slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function mockProbe(): () => Promise<void> {
  return async () => {};
}
