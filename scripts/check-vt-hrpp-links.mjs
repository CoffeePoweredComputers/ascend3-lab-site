#!/usr/bin/env node
/**
 * VT HRPP / IRB link health check.
 *
 * Every IRB resource the wiki hands out points at a SPECIFIC HRPP document or
 * page. Those deep .docx/.doc URLs rot when VT reorganizes its site, so this
 * script verifies each one still resolves.
 *
 * It checks two sources:
 *   1. src/data/vt-hrpp-links.json — the registry the IRB Pathfinder renders.
 *   2. Inline VT (research/policies) URLs in src/content/wiki/irb/*.mdx prose.
 *
 * Fails (exit 1) if any URL is unreachable or returns >= 400. Also warns (no
 * failure) when two registry entries share one URL — the "every link goes to
 * the same page" smell this registry exists to prevent.
 *
 * No dependencies; run with `node scripts/check-vt-hrpp-links.mjs`
 * (or `npm run check:irb-links`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = join(root, 'src/data/vt-hrpp-links.json');
const irbContentDir = join(root, 'src/content/wiki/irb');

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

// ── Collect the URLs to check (deduped; remember where each was first seen) ──
const targets = new Map(); // url -> label
const addTarget = (url, label) => {
  if (!targets.has(url)) targets.set(url, label);
};

for (const [key, link] of Object.entries(registry)) addTarget(link.url, `registry:${key}`);

// Inline VT links in IRB lesson prose (any subdomain of research/policies.vt.edu).
const vtUrlRe = /https?:\/\/(?:[\w-]+\.)*(?:research|policies)\.vt\.edu\/[^\s)"'<>]+/gi;
const mdxFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? mdxFiles(full) : full.endsWith('.mdx') ? [full] : [];
  });
for (const file of mdxFiles(irbContentDir)) {
  for (const m of readFileSync(file, 'utf8').matchAll(vtUrlRe)) {
    addTarget(m[0], `prose:${relative(root, file)}`);
  }
}

// ── Warn on duplicate URLs within the registry (the bug this guards against) ──
const byUrl = new Map();
for (const [key, link] of Object.entries(registry)) {
  if (!byUrl.has(link.url)) byUrl.set(link.url, []);
  byUrl.get(link.url).push(key);
}
const dupes = [...byUrl.entries()].filter(([, keys]) => keys.length > 1);
if (dupes.length) {
  console.warn(`⚠ ${dupes.length} registry URL(s) shared by more than one entry (each should point to its own doc):`);
  for (const [url, keys] of dupes) console.warn(`  ${keys.join(', ')} → ${url}`);
}

// ── HTTP check: trust HEAD only when happy, else fall back to GET ──────────
async function check(url) {
  for (const method of ['HEAD', 'GET']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'ascend-wiki-linkcheck/1.0' },
      });
      // A 3xx means the server knows the path and is redirecting — a login-gated
      // portal (302 → CAS) or an http→https/trailing-slash normalization. That is
      // alive, not rot; only >= 400 or a network failure is a broken link.
      // Some servers reject/misreport HEAD; retry once with GET before trusting it.
      if (res.status >= 400 && method === 'HEAD') continue;
      return { ok: res.status < 400, status: res.status };
    } catch (err) {
      if (method === 'GET') return { ok: false, status: err.name === 'AbortError' ? 'timeout' : 'error' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 'error' };
}

const results = await Promise.all(
  [...targets.entries()].map(async ([url, label]) => ({ url, label, ...(await check(url)) })),
);

// Failures first, then alphabetical for stable output.
results.sort((a, b) => Number(a.ok) - Number(b.ok) || a.url.localeCompare(b.url));
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${String(r.status).padEnd(7)} ${r.url}  (${r.label})`);
}

const broken = results.filter((r) => !r.ok);
if (broken.length) {
  console.error(
    `\n✗ ${broken.length} IRB link(s) failed. Find the current URL on the HRPP site ` +
      `(https://www.research.vt.edu/sirc/hrpp/) and update src/data/vt-hrpp-links.json or the lesson prose.`,
  );
  process.exit(1);
}

console.log(`\n✓ all ${results.length} IRB link(s) resolve.`);
