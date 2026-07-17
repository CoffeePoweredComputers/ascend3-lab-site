/**
 * Generates the quantitative module's running-example datasets (synthetic, seeded,
 * deterministic — rerunning always produces identical files):
 *
 *   public/templates/debugging-study.csv  — the SPRINT debugging-intervention study.
 *     Long format, one row per exercise attempt (462 rows, 40 students × 12
 *     exercises minus 18 skips). Student-level columns (section, pre, post,
 *     se1–se6) repeat on every row so GEE/multilevel code needs no reshaping.
 *   public/templates/dci-pilot.csv        — Debugging Concept Inventory pilot.
 *     N = 150, items i01–i20 scored 0/1, no missing values. Two items are
 *     deliberately broken: i07 is mis-keyed (negative discrimination) and i12
 *     is near-ceiling. Lessons ask readers to find them.
 *   src/data/quant-item-stats.json        — classical item stats computed from
 *     dci-pilot.csv (p, corrected point-biserial), consumed by ItemAnalysisTable
 *     so the lesson table always matches the shipped CSV.
 *
 * Run: node scripts/generate-quant-data.mjs
 */
import { writeFileSync } from 'node:fs';

// mulberry32 — tiny seeded PRNG so the CSVs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260717);
const randn = () => {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const logistic = (x) => 1 / (1 + Math.exp(-x));
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* ── debugging-study.csv ─────────────────────────────────────────────── */

const N_STUDENTS = 40;
const N_EXERCISES = 12;
const students = [];
for (let i = 1; i <= N_STUDENTS; i++) {
  const id = `S${String(i).padStart(2, '0')}`;
  const section = i <= 21 ? 'sprint' : 'control';
  const ability = randn();
  const pre = Math.round(clip(9.5 + 2.4 * ability + 1.6 * randn(), 0, 20));
  const gain = (section === 'sprint' ? 2.6 : 1.1) + 1.4 * randn();
  const post = Math.round(clip(pre + gain - 0.06 * Math.max(0, pre - 15) ** 2 / 4, 0, 20));
  // Post-course debugging self-efficacy, six 1–5 Likert items.
  const seBase = 3 + 0.55 * ability + (section === 'sprint' ? 0.35 : 0);
  const se = Array.from({ length: 6 }, () => clip(Math.round(seBase + 0.9 * randn()), 1, 5));
  students.push({ id, section, ability, pre, post, se });
}

// Exercise difficulties, easy → hard across the semester's set.
const exDifficulty = Array.from({ length: N_EXERCISES }, (_, j) => -1.4 + (2.8 * j) / (N_EXERCISES - 1));

// 18 skipped (student, exercise) pairs → exactly 462 attempt rows.
const allPairs = [];
for (let i = 0; i < N_STUDENTS; i++) for (let j = 0; j < N_EXERCISES; j++) allPairs.push([i, j]);
const skipped = new Set();
while (skipped.size < 18) {
  const k = Math.floor(rand() * allPairs.length);
  // Weaker students are a bit likelier to skip (keeps the MAR discussion honest).
  const [i] = allPairs[k];
  if (students[i].ability < 0 || rand() < 0.4) skipped.add(k);
}

const studyRows = [['student', 'section', 'pre', 'post', 'se1', 'se2', 'se3', 'se4', 'se5', 'se6', 'exercise', 'fixed', 'minutes']];
allPairs.forEach(([i, j], k) => {
  if (skipped.has(k)) return;
  const s = students[i];
  const boost = s.section === 'sprint' ? 0.55 : 0;
  // Latent solve time (minutes), lognormal-ish and right-skewed; capped at the 30-min timeout.
  const speed = s.ability + boost - exDifficulty[j];
  const solveTime = Math.exp(2.1 - 0.45 * speed + 0.55 * randn());
  const fixed = solveTime <= 10 ? 1 : 0;
  const minutes = clip(solveTime, 0.5, 30).toFixed(1);
  studyRows.push([s.id, s.section, s.pre, s.post, ...s.se, `E${String(j + 1).padStart(2, '0')}`, fixed, minutes]);
});

/* ── dci-pilot.csv ───────────────────────────────────────────────────── */

const N_PILOT = 150;
const N_ITEMS = 20;
// Rasch-style difficulties spread over the ability range; two seeded problems:
//   i07 mis-keyed → responses inverted (negative discrimination)
//   i12 near-ceiling (b = -3.1, almost everyone correct)
const b = Array.from({ length: N_ITEMS }, (_, j) => -2.0 + (4.4 * j) / (N_ITEMS - 1));
b[11] = -3.1;
const pilotRows = [['id', ...Array.from({ length: N_ITEMS }, (_, j) => `i${String(j + 1).padStart(2, '0')}`)]];
const resp = [];
for (let i = 1; i <= N_PILOT; i++) {
  const theta = randn();
  const row = [];
  for (let j = 0; j < N_ITEMS; j++) {
    let correct = rand() < logistic(theta - b[j]) ? 1 : 0;
    if (j === 6) correct = 1 - correct; // i07 mis-keyed
    row.push(correct);
  }
  resp.push(row);
  pilotRows.push([`D${String(i).padStart(3, '0')}`, ...row]);
}

/* ── classical item stats for ItemAnalysisTable ──────────────────────── */

const totals = resp.map((r) => r.reduce((a, x) => a + x, 0));
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const itemStats = [];
for (let j = 0; j < N_ITEMS; j++) {
  const item = resp.map((r) => r[j]);
  const rest = resp.map((r, i) => totals[i] - r[j]); // corrected: item removed from total
  const p = mean(item);
  const mi = mean(rest.filter((_, i) => item[i] === 1));
  const mo = mean(rest.filter((_, i) => item[i] === 0));
  const rpb = ((mi - mo) / sd(rest)) * Math.sqrt(p * (1 - p) * (N_PILOT / (N_PILOT - 1)));
  itemStats.push({ item: `i${String(j + 1).padStart(2, '0')}`, p: +p.toFixed(2), rpb: +rpb.toFixed(2) });
}

/* ── write files ─────────────────────────────────────────────────────── */

const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';
writeFileSync('public/templates/debugging-study.csv', csv(studyRows));
writeFileSync('public/templates/dci-pilot.csv', csv(pilotRows));
writeFileSync('src/data/quant-item-stats.json', JSON.stringify(itemStats, null, 1) + '\n');

// Console summary — handy when writing lesson prose against the data.
const bySec = (sec) => students.filter((s) => s.section === sec);
const fmt = (x) => x.toFixed(2);
const attempts = studyRows.length - 1;
const fixedRate = (rows) => mean(rows.map((r) => +r[11]));
const sprintRows = studyRows.slice(1).filter((r) => r[1] === 'sprint');
const controlRows = studyRows.slice(1).filter((r) => r[1] === 'control');
console.log(`debugging-study.csv: ${attempts} attempts, ${N_STUDENTS} students`);
console.log(`  pre  mean sprint ${fmt(mean(bySec('sprint').map((s) => s.pre)))} control ${fmt(mean(bySec('control').map((s) => s.pre)))}`);
console.log(`  post mean sprint ${fmt(mean(bySec('sprint').map((s) => s.post)))} control ${fmt(mean(bySec('control').map((s) => s.post)))}`);
console.log(`  fixed-rate sprint ${fmt(fixedRate(sprintRows))} control ${fmt(fixedRate(controlRows))}`);
const mins = studyRows.slice(1).map((r) => +r[12]).sort((a, b2) => a - b2);
console.log(`  minutes mean ${fmt(mean(mins))} median ${fmt(mins[Math.floor(mins.length / 2)])} (right-skewed: ${fmt(mins[mins.length - 1])} max)`);
console.log(`dci-pilot.csv: N=${N_PILOT}, mean total ${fmt(mean(totals))}/20, alpha-ish item set`);
console.log('  flagged:', itemStats.filter((s) => s.rpb < 0.1 || s.p > 0.9).map((s) => `${s.item} (p=${s.p}, rpb=${s.rpb})`).join(', '));
