import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContent, firstJsonObject, matchProbeType, parseModelOutput } from '../src/engine/parse.js';

const opts = {
  probeTypes: ['DESCRIPTIVE_EXTERNAL', 'DESCRIPTIVE_INTERNAL', 'IDIOGRAPHIC', 'CLARIFYING', 'EXPLANATORY'],
  moveOnToken: 'MOVE_ON',
  maxQuestionWords: 25,
};

test('bare move-on token', () => {
  assert.deepEqual(parseModelOutput('MOVE_ON', opts), { kind: 'move_on' });
  assert.deepEqual(parseModelOutput('  move_on.\n', opts), { kind: 'move_on' });
  assert.deepEqual(parseModelOutput('Decision: MOVE_ON', opts), { kind: 'move_on' });
});

test('plain JSON probe', () => {
  const r = parseModelOutput('{"probe_type":"CLARIFYING","trigger":"used \\"fine\\"","question":"What made it feel fine to you?"}', opts);
  assert.equal(r.kind, 'probe');
  if (r.kind !== 'probe') return;
  assert.equal(r.probeType, 'CLARIFYING');
  assert.equal(r.question, 'What made it feel fine to you?');
  assert.equal(r.trigger, 'used "fine"');
  assert.deepEqual(r.flags, {});
});

test('fenced JSON with think block and curly quotes', () => {
  const content =
    '<think>the answer is generic</think>\n```json\n{“probe_type”: “Idiographic”, “trigger”: “said usually”, “question”: “Can you walk me through one specific time?”}\n```';
  const r = parseModelOutput(content, opts);
  assert.equal(r.kind, 'probe');
  if (r.kind !== 'probe') return;
  assert.equal(r.probeType, 'IDIOGRAPHIC');
  assert.equal(r.question, 'Can you walk me through one specific time?');
});

test('unknown probe type is a parse error, not a probe', () => {
  const r = parseModelOutput('{"probe_type":"LEADING","trigger":"x","question":"Why was that bad?"}', opts);
  assert.equal(r.kind, 'parse_error');
});

test('unique prefix normalises with a flag', () => {
  const r = parseModelOutput('{"probe_type":"explan","trigger":"x","question":"Why do you think it went that way?"}', opts);
  assert.equal(r.kind, 'probe');
  if (r.kind !== 'probe') return;
  assert.equal(r.probeType, 'EXPLANATORY');
  assert.equal(r.flags.normalized_probe_type, 'explan');
});

test('ambiguous prefix (DESCRIPTIVE) is rejected', () => {
  assert.equal(matchProbeType('DESCRIPTIVE', opts.probeTypes), null);
});

test('overlength question is asked but flagged', () => {
  const q = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
  const r = parseModelOutput(`{"probe_type":"CLARIFYING","trigger":"x","question":"${q}"}`, opts);
  assert.equal(r.kind, 'probe');
  if (r.kind !== 'probe') return;
  assert.equal(r.flags.overlength, 30);
});

test('wrapped move-on inside JSON', () => {
  assert.deepEqual(parseModelOutput('{"decision":"MOVE_ON"}', opts), { kind: 'move_on' });
});

test('missing question / malformed JSON / empty', () => {
  assert.equal(parseModelOutput('{"probe_type":"CLARIFYING"}', opts).kind, 'parse_error');
  assert.equal(parseModelOutput('{"probe_type": CLARIFYING', opts).kind, 'parse_error');
  assert.equal(parseModelOutput('', opts).kind, 'parse_error');
  assert.equal(parseModelOutput(null, opts).kind, 'parse_error');
  assert.equal(parseModelOutput('Sure! Here is a follow-up: What happened next?', opts).kind, 'parse_error');
});

test('firstJsonObject respects strings with braces', () => {
  assert.equal(firstJsonObject('x {"a":"}{","b":{"c":1}} y'), '{"a":"}{","b":{"c":1}}');
  assert.equal(firstJsonObject('{"unterminated": 1'), null);
});

test('extractContent handles string and array content', () => {
  assert.equal(extractContent({ choices: [{ message: { content: 'MOVE_ON' } }] }), 'MOVE_ON');
  assert.equal(extractContent({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'a\nb');
  assert.equal(extractContent({}), null);
});

test('extractFinishReason', async () => {
  const { extractFinishReason } = await import('../src/engine/parse.js');
  assert.equal(extractFinishReason({ choices: [{ finish_reason: 'length' }] }), 'length');
  assert.equal(extractFinishReason({ choices: [{}] }), null);
  assert.equal(extractFinishReason(null), null);
});

test('curly quotes INSIDE a string value are preserved (regression: real ARC reply was rejected)', () => {
  const content = '{"probe_type":"IDIOGRAPHIC","trigger":"need a specific instance of confusion","question":"Can you recall a particular moment when the meaning of “meets and exceeds” was unclear?"}';
  const r = parseModelOutput(content, opts);
  assert.equal(r.kind, 'probe');
  if (r.kind !== 'probe') return;
  assert.equal(r.question, 'Can you recall a particular moment when the meaning of “meets and exceeds” was unclear?');
});
