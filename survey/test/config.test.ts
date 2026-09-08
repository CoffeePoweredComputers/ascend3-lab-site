import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalJson, ConfigRegistry, fromRaw, loadSurveyDir, versionOf } from '../src/config/load.js';

const fixture = () => JSON.parse(readFileSync('test/fixtures/surveys/e2e-demo.json', 'utf8'));

test('the real survey file loads and hashes deterministically', () => {
  const [s] = loadSurveyDir('surveys');
  assert.ok(s);
  assert.equal(s.config.id, 'irb-26-817');
  assert.equal(s.config.waves.length, 3);
  for (const w of s.config.waves) assert.equal(w.starters.length, 4);
  assert.equal(s.config.probing.maxTurnsPerSession, 16);
  assert.match(s.version, /^[0-9a-f]{64}$/);
  assert.equal(s.version, versionOf(s.raw));
  assert.match(s.sheetHtml, /<h2[^>]*>Title of research study/);
  // verbatim wording checks from Instrument S1
  assert.equal(s.config.waves[0]!.starters[0]!.text, "Tell me about a point in this project where it wasn't clear what you were supposed to do.".replace("wasn't", 'wasn’t'));
  assert.ok(s.config.probing.systemPrompt.startsWith('You generate follow-up questions'));
  assert.ok(s.config.probing.systemPrompt.includes('MOVE_ON'));
});

test('canonical JSON ignores key order and whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(versionOf({ a: 1, b: 2 }), versionOf({ b: 2, a: 1 }));
  assert.notEqual(versionOf({ a: 1 }), versionOf({ a: 2 }));
});

test('defaults are applied', () => {
  const raw = fixture();
  delete raw.probing.moveOnToken;
  delete raw.probing.maxQuestionWords;
  delete raw.model.temperature;
  const s = fromRaw(raw, 't');
  assert.equal(s.config.probing.moveOnToken, 'MOVE_ON');
  assert.equal(s.config.probing.maxQuestionWords, 25);
  assert.equal(s.config.model.temperature, 0.3);
});

test('cross-record invariants fail loud', () => {
  const dupStarter = fixture();
  dupStarter.waves[0].starters[1].id = 's1';
  assert.throws(() => fromRaw(dupStarter, 't'), /duplicate starter id "s1"/);

  const overlap = fixture();
  overlap.waves.push({ ...fixture().waves[0], id: 'w2', opensAt: '2050-01-01T00:00:00Z', closesAt: '2150-01-01T00:00:00Z' });
  assert.throws(() => fromRaw(overlap, 't'), /overlap/);

  const noToken = fixture();
  noToken.probing.systemPrompt = 'Never mentions the token.';
  assert.throws(() => fromRaw(noToken, 't'), /never mentions the move-on token/);

  const cap = fixture();
  cap.probing.maxTurnsPerSession = 1;
  assert.throws(() => fromRaw(cap, 't'), /maxTurnsPerSession is 1/);

  const badPid = fixture();
  badPid.roles.researchers = ['DHSmith4'];
  assert.throws(() => fromRaw(badPid, 't'), /PID must be lowercase/);

  const inverted = fixture();
  inverted.waves[0].closesAt = '1999-01-01T00:00:00Z';
  assert.throws(() => fromRaw(inverted, 't'), /opensAt must be before closesAt/);
});

test('registry keeps historical versions and rejects a mismatched snapshot', () => {
  const current = fromRaw(fixture(), 'cur');
  const reg = new ConfigRegistry([current]);
  const old = fixture();
  old.title = 'Older title';
  const oldVersion = versionOf(old);
  reg.addHistorical(old, oldVersion, 'e2e-demo');
  assert.equal(reg.getVersion(oldVersion)?.config.title, 'Older title');
  assert.equal(reg.get('e2e-demo')?.config.title, 'E2E demo survey');
  assert.throws(() => reg.addHistorical(old, 'deadbeef'.repeat(8), 'e2e-demo'), /hashes to/);
});

test('$schema is allowed, stripped from the stored raw, and does not change the version', () => {
  const raw = fixture();
  const a = fromRaw(raw, 'a');
  const b = fromRaw({ $schema: './survey.schema.json', ...raw }, 'b');
  assert.equal(a.version, b.version);
  assert.ok(!('$schema' in (b.raw as Record<string, unknown>)));
});

test('the committed editor schema is up to date (run `npm run schema` if this fails)', async () => {
  const { renderSchema, SCHEMA_PATH } = await import('../scripts/schema.js');
  assert.equal(readFileSync(SCHEMA_PATH, 'utf8'), renderSchema());
});

test('the template validates and scaffolds a draft survey', () => {
  const t = JSON.parse(readFileSync('templates/minimal.json', 'utf8'));
  const s = fromRaw({ ...t, id: 'scaffold-test', title: 'Scaffold' }, 'template');
  assert.equal(s.config.status, 'draft');
  assert.equal(s.config.waves[0]!.starters.length, 3);
});

test('loadSurveyDir ignores the schema file and scratch files', () => {
  // Asserts the filter, not the census: adding a survey file must not fail this.
  const ids = loadSurveyDir('surveys').map((s) => s.config.id);
  assert.ok(ids.includes('irb-26-817'), 'real surveys load');
  assert.ok(!ids.some((id) => id.endsWith('.schema') || id.startsWith('_')), 'schema and scratch files are not surveys');
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual([...ids].sort(), ids, 'returned in sorted order');
});
