/** Survey creation from the admin form (src/config/create.ts). No database needed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCreatedSurvey, createDefaults, DEFAULT_CONSENT, endOfDayIn, slugify, uniqueId, withStatus } from '../src/config/create.js';

test('slugify makes a usable id from any title', () => {
  assert.equal(slugify('CS 2114 reflections, Fall!'), 'cs-2114-reflections-fall');
  assert.equal(slugify('   '), 'survey');
  assert.equal(slugify('Ünïcödé — yes'), 'unicode-yes');
  assert.equal(slugify('x'.repeat(100)).length, 40);
  assert.match(slugify('a-'.repeat(30)), /[a-z0-9]$/, 'never ends in a hyphen');
});

test('endOfDayIn: end of the calendar day in Virginia, across the DST switch', () => {
  assert.equal(endOfDayIn('2026-07-04').toISOString(), '2026-07-05T03:59:59.000Z', 'EDT, −4');
  assert.equal(endOfDayIn('2026-12-01').toISOString(), '2026-12-02T04:59:59.000Z', 'EST, −5');
  assert.equal(endOfDayIn('2026-11-01').toISOString(), '2026-11-02T04:59:59.000Z', 'the day DST ends is already EST by 23:59');
  assert.equal(endOfDayIn('2026-03-08').toISOString(), '2026-03-09T03:59:59.000Z', 'the day DST starts is EDT by 23:59');
  assert.throws(() => endOfDayIn('soon'), /YYYY-MM-DD/);
});

test('uniqueId appends -2, -3, … until free', () => {
  const taken = new Set(['demo', 'demo-2']);
  assert.equal(uniqueId('demo', (id) => taken.has(id)), 'demo-3');
  assert.equal(uniqueId('fresh', (id) => taken.has(id)), 'fresh');
});

test('defaults come from the template plus the built-in consent text', () => {
  const d = createDefaults();
  assert.equal(d.consentMarkdown, DEFAULT_CONSENT);
  assert.ok(d.systemPrompt.includes('MOVE_ON'));
  assert.ok(d.agreeLabel.length > 10);
  assert.equal(d.maxProbes, 1);
});

test('buildCreatedSurvey assembles a valid, open, single-wave survey owned by its creator', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const s = buildCreatedSurvey(
    { title: '  Team check-in ', questions: ['What went well?', '', 'What was hard?  '], maxProbes: 1, closesAt: '2026-12-01' },
    { id: 'team-check-in', creatorPid: 'abc1', now },
  );
  assert.equal(s.source, 'db');
  assert.equal(s.config.id, 'team-check-in');
  assert.equal(s.config.title, 'Team check-in');
  assert.equal(s.config.status, 'open');
  assert.deepEqual(s.config.roles, { researchers: ['abc1'], keyholders: ['abc1'] });
  assert.equal(s.config.eligibility.guestAccess, false);
  assert.equal(s.config.waves.length, 1);
  assert.equal(s.config.waves[0]!.opensAt, now.toISOString());
  assert.equal(s.config.waves[0]!.closesAt, '2026-12-02T04:59:59.000Z', 'end of Dec 1 in Blacksburg (EST)');
  assert.deepEqual(
    s.config.waves[0]!.starters.map((q) => [q.id, q.text]),
    [
      ['q1', 'What went well?'],
      ['q2', 'What was hard?'],
    ],
  );
  assert.equal(s.config.probing.maxProbesPerStarter, 1);
  assert.equal(s.config.probing.maxTurnsPerSession, 4);
  assert.equal(s.config.consent.sheetMarkdown, DEFAULT_CONSENT);
  assert.match(s.sheetHtml, /<h1>Before you start<\/h1>/);
  assert.equal(s.version.length, 64);
});

test('buildCreatedSurvey honours overrides and defaults 90 days out', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const s = buildCreatedSurvey(
    { title: 'T', questions: ['q'], maxProbes: 3, consentMarkdown: '# Mine', opening: 'Hi', closing: 'Bye', systemPrompt: 'Say MOVE_ON', agreeLabel: 'Sure' },
    { id: 't', creatorPid: 'x', now },
  );
  assert.equal(s.config.consent.sheetMarkdown, '# Mine');
  assert.equal(s.config.opening, 'Hi');
  assert.equal(s.config.closing, 'Bye');
  assert.equal(s.config.probing.systemPrompt, 'Say MOVE_ON');
  assert.equal(s.config.consent.agreeLabel, 'Sure');
  assert.equal(s.config.probing.maxTurnsPerSession, 4);
  assert.equal(Date.parse(s.config.waves[0]!.closesAt) - now.getTime(), 90 * 86_400_000);
});

test('buildCreatedSurvey refuses what the schema or the form cannot accept', () => {
  const base = { title: 'T', questions: ['q'], maxProbes: 1 };
  assert.throws(() => buildCreatedSurvey({ ...base, questions: ['', '  '] }, { id: 't', creatorPid: 'x' }), /question/);
  assert.throws(() => buildCreatedSurvey({ ...base, closesAt: '2000-01-01' }, { id: 't', creatorPid: 'x' }), /future/);
  assert.throws(() => buildCreatedSurvey({ ...base, closesAt: 'soon' }, { id: 't', creatorPid: 'x' }), /YYYY-MM-DD/);
  assert.throws(() => buildCreatedSurvey({ ...base, maxProbes: 7 }, { id: 't', creatorPid: 'x' }), /0 to 3/);
  assert.throws(() => buildCreatedSurvey({ ...base, systemPrompt: 'no token here' }, { id: 't', creatorPid: 'x' }), /move-on token/);
});

test('withStatus re-hashes: a status change is a new config version', () => {
  const a = buildCreatedSurvey({ title: 'T', questions: ['q'], maxProbes: 0 }, { id: 't', creatorPid: 'x', now: new Date('2026-09-21T12:00:00Z') });
  const b = withStatus(a, 'closed');
  assert.equal(b.config.status, 'closed');
  assert.equal(b.source, 'db');
  assert.notEqual(b.version, a.version);
  assert.equal(withStatus(b, 'open').version, a.version, 'and back again is the original version');
});
