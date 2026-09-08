import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromRaw } from '../src/config/load.js';
import { canProbe, currentWave, generateCode, nextWave, waveIsOpen } from '../src/engine/session.js';
import { buildMessages } from '../src/engine/prompt.js';
import { MockClient } from '../src/llm/mock.js';
import { parseModelOutput, extractContent } from '../src/engine/parse.js';
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('test/fixtures/surveys/e2e-demo.json', 'utf8'));
const cfg = fromRaw(raw, 'fixture').config;
const wave = cfg.waves[0]!;
const starter = wave.starters[0]!;

test('canProbe: probe limit, then turn cap, then ok', () => {
  assert.deepEqual(canProbe({ probeCount: 2, turnCount: 3 }, cfg, starter), { ok: false, trigger: 'probe_limit' });
  assert.deepEqual(canProbe({ probeCount: 1, turnCount: 5 }, cfg, starter), { ok: false, trigger: 'turn_cap' });
  assert.deepEqual(canProbe({ probeCount: 1, turnCount: 4 }, cfg, starter), { ok: true });
  // per-starter override wins
  assert.deepEqual(canProbe({ probeCount: 0, turnCount: 1 }, cfg, { ...starter, maxProbes: 0 }), { ok: false, trigger: 'probe_limit' });
});

test('wave windows', () => {
  const w = { ...wave, opensAt: '2026-09-21T00:00:00-04:00', closesAt: '2026-10-05T00:00:00-04:00' };
  assert.equal(waveIsOpen(w, Date.parse('2026-09-20T23:59:00-04:00')), false);
  assert.equal(waveIsOpen(w, Date.parse('2026-09-21T00:00:00-04:00')), true);
  assert.equal(waveIsOpen(w, Date.parse('2026-10-05T00:00:00-04:00')), false);
  const c = { ...cfg, waves: [w, { ...w, id: 'w2', opensAt: '2026-10-19T00:00:00-04:00', closesAt: '2026-11-02T00:00:00-05:00' }] };
  assert.equal(currentWave(c, Date.parse('2026-09-25T12:00:00-04:00'))?.id, 'w1');
  assert.equal(currentWave(c, Date.parse('2026-10-10T12:00:00-04:00')), null);
  assert.equal(nextWave(c, Date.parse('2026-10-10T12:00:00-04:00'))?.id, 'w2');
  assert.equal(nextWave(c, Date.parse('2027-01-01T00:00:00Z')), null);
});

test('participant codes use the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^P-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(generateCode(() => 0), 'P-AAAAAA');
});

test('prompt contains only the current starter block and the count', () => {
  const turns = [
    { seq: 1, kind: 'starter' as const, starterIndex: 0, starterId: 's1', probeIndex: 0, probeType: null, trigger: null, text: starter.text, flags: {}, llmCallId: null },
    { seq: 2, kind: 'answer' as const, starterIndex: 0, starterId: 's1', probeIndex: 0, probeType: null, trigger: null, text: 'We argued a lot.', flags: {}, llmCallId: null },
    { seq: 3, kind: 'probe' as const, starterIndex: 0, starterId: 's1', probeIndex: 1, probeType: 'CLARIFYING', trigger: 'x', text: 'What did "a lot" look like?', flags: {}, llmCallId: null },
    { seq: 4, kind: 'answer' as const, starterIndex: 0, starterId: 's1', probeIndex: 1, probeType: null, trigger: null, text: 'Daily.', flags: {}, llmCallId: null },
  ];
  const msgs = buildMessages(cfg, starter, turns, 1, 2);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, 'system');
  assert.equal(msgs[0]!.content, cfg.probing.systemPrompt);
  const u = msgs[1]!.content;
  assert.match(u, /^Main question: Tell me about a time something was unclear\./);
  assert.match(u, /Q \(main\): Tell me about/);
  assert.match(u, /A: We argued a lot\./);
  assert.match(u, /Q \(follow-up 1, CLARIFYING\): What did "a lot" look like\?/);
  assert.match(u, /Follow-ups asked so far on this question: 1 of 2\./);
  assert.match(u, /Reply with exactly MOVE_ON/);
  assert.ok(!/P-[A-Z0-9]{6}|pid|wave|w1/.test(u), 'no identity or wave leakage');
});

test('mock client: short answer → move on; long → taxonomy-valid probe; parser round-trips it', async () => {
  const mock = new MockClient();
  const base = { model: 'm', temperature: 0, maxTokens: 50, timeoutMs: 1000, hints: { probeTypes: cfg.probing.probeTypes, moveOnToken: 'MOVE_ON' } };
  const short = await mock.complete({ ...base, messages: buildMessages(cfg, starter, [
    { seq: 1, kind: 'starter', starterIndex: 0, starterId: 's1', probeIndex: 0, probeType: null, trigger: null, text: starter.text, flags: {}, llmCallId: null },
    { seq: 2, kind: 'answer', starterIndex: 0, starterId: 's1', probeIndex: 0, probeType: null, trigger: null, text: 'no idea', flags: {}, llmCallId: null },
  ], 0, 2) });
  const opts = { probeTypes: cfg.probing.probeTypes, moveOnToken: 'MOVE_ON', maxQuestionWords: 25 };
  assert.deepEqual(parseModelOutput(extractContent(short.body), opts), { kind: 'move_on' });
  const long = await mock.complete({ ...base, messages: buildMessages(cfg, starter, [
    { seq: 1, kind: 'starter', starterIndex: 0, starterId: 's1', probeIndex: 0, probeType: null, trigger: null, text: starter.text, flags: {}, llmCallId: null },
    { seq: 2, kind: 'answer', starterIndex: 0, starterId: 's1', probeIndex: 0, probeType: null, trigger: null, text: 'we spent a very long time arguing about the rubric wording', flags: {}, llmCallId: null },
  ], 0, 2) });
  const r = parseModelOutput(extractContent(long.body), opts);
  assert.equal(r.kind, 'probe');
  if (r.kind === 'probe') assert.ok(cfg.probing.probeTypes.includes(r.probeType));
});
