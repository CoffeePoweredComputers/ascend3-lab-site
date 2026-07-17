#!/usr/bin/env node
/**
 * Citation integrity check.
 *
 * Fails (exit 1) if any <Cite id="…"> in lesson content points at an id that is
 * not defined in src/data/references.json — i.e. a citation that would render a
 * broken "(?id)" link. Also prints non-failing warnings for references that are
 * still flagged `verified:false` and for library entries that are never cited.
 *
 * No dependencies; run with `node scripts/check-citations.mjs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const refsPath = join(root, 'src/data/references.json');
const contentDir = join(root, 'src/content/wiki');

const refs = JSON.parse(readFileSync(refsPath, 'utf8'));
const byId = new Map(refs.map((r) => [r.id, r]));
const validIds = new Set(refs.map((r) => r.id));
const unverified = refs.filter((r) => r.verified === false).map((r) => r.id);

// Which references each module's /references page renders (must match the
// <ReferenceList tags={…}> on each module's references.mdx). null = all refs.
// A <Cite> only produces a working link if its ref appears on its module's page.
const moduleFilter = {
  qualitative: ['foundations', 'trustworthiness', 'reasoning', 'methodologies', 'thematic-analysis', 'irr', 'education', 'hci'],
  irb: ['irb'],
  quantitative: ['quant', 'measurement', 'genai'],
  'project-management': ['pm'],
};
const onModulePage = (ref, mod) => {
  const filter = mod in moduleFilter ? moduleFilter[mod] : null;
  return filter === null || ref.tags.some((t) => filter.includes(t));
};

/** Recursively collect .mdx files. */
function mdxFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? mdxFiles(full) : full.endsWith('.mdx') ? [full] : [];
  });
}

const citeRe = /<Cite\s+[^>]*id=["']([^"']+)["']/g;
const missing = [];
const unlinkable = [];
const usedIds = new Set();

for (const file of mdxFiles(contentDir)) {
  const text = readFileSync(file, 'utf8');
  const mod = relative(contentDir, file).split('/')[0]; // src/content/wiki/<mod>/…
  for (const m of text.matchAll(citeRe)) {
    const id = m[1];
    usedIds.add(id);
    if (!validIds.has(id)) {
      missing.push({ file: relative(root, file), id });
    } else if (!onModulePage(byId.get(id), mod)) {
      unlinkable.push({ file: relative(root, file), id, mod });
    }
  }
}

const unused = refs.map((r) => r.id).filter((id) => !usedIds.has(id));

// Warnings (do not fail the build)
if (unverified.length) {
  console.warn(`⚠ ${unverified.length} reference(s) still flagged verified:false: ${unverified.join(', ')}`);
}
if (unused.length) {
  console.warn(`⚠ ${unused.length} reference(s) defined but never cited (ok, just noting): ${unused.join(', ')}`);
}

// Hard failure: a citation with no matching reference
if (missing.length) {
  console.error(`\n✗ ${missing.length} citation(s) reference an unknown id:`);
  for (const { file, id } of missing) console.error(`  ${file} → <Cite id="${id}">`);
  console.error('\nFix the id or add the reference to src/data/references.json.');
}

// Hard failure: a citation whose ref is not on its module's references page (broken link)
if (unlinkable.length) {
  console.error(`\n✗ ${unlinkable.length} citation(s) link to a references page that won't list them:`);
  for (const { file, id, mod } of unlinkable) {
    console.error(`  ${file} → <Cite id="${id}"> (ref not tagged for the "${mod}" references page)`);
  }
  console.error('\nTag the reference for that module, or move the citation.');
}

if (missing.length || unlinkable.length) process.exit(1);

console.log(
  `✓ citations ok — ${usedIds.size} cited id(s), all resolve and link; ` +
    `0 missing, 0 unlinkable, ${unverified.length} unverified.`,
);
