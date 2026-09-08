import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompletionRequest, CompletionResult, LlmClient } from '../src/llm/index.js';
import { LlmMonitor } from '../src/llm/monitor.js';

function fakeClient(): LlmClient & { fail: boolean; latency: number } {
  return {
    name: 'fake',
    fail: false,
    latency: 900,
    async complete(_req: CompletionRequest): Promise<CompletionResult> {
      if (this.fail) throw new Error('boom');
      return { body: {}, latencyMs: this.latency };
    },
  };
}

const req: CompletionRequest = { model: 'm', messages: [], temperature: 0, maxTokens: 10, timeoutMs: 1000 };

test('monitor state machine', async () => {
  const inner = fakeClient();
  let probeFail = false;
  let clock = 1_000_000;
  const m = new LlmMonitor(inner, {
    probe: async () => {
      if (probeFail) throw new Error('ARC 403: VPN');
    },
    slowMs: 10_000,
    now: () => (clock += 10),
  });

  assert.equal(m.status().state, 'unknown');
  assert.equal(m.status().provider, 'fake');

  await m.runProbe();
  assert.equal(m.status().state, 'ok');
  assert.equal(m.status().probe.error, null);

  await m.complete(req);
  let s = m.status();
  assert.equal(s.state, 'ok');
  assert.equal(s.model, 'm');
  assert.equal(s.lastCall.ok, true);
  assert.equal(s.lastCall.ms, 900);

  inner.latency = 12_000;
  await m.complete(req);
  assert.equal(m.status().state, 'degraded', 'slow call degrades');

  inner.fail = true;
  await assert.rejects(m.complete(req));
  s = m.status();
  assert.equal(s.state, 'degraded');
  assert.equal(s.consecutiveFailures, 1);
  assert.equal(s.lastCall.error, 'boom');

  await assert.rejects(m.complete(req));
  assert.equal(m.status().state, 'down', 'two consecutive failures');

  await m.runProbe();
  assert.equal(m.status().state, 'degraded', 'a passing probe decays down → degraded');
  assert.equal(m.status().consecutiveFailures, 1);

  inner.fail = false;
  inner.latency = 800;
  await m.complete(req);
  assert.equal(m.status().state, 'ok');

  probeFail = true;
  await m.runProbe();
  s = m.status();
  assert.equal(s.state, 'down');
  assert.match(s.probe.error ?? '', /403/);

  m.start();
  m.stop();
});
