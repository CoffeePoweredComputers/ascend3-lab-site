#!/usr/bin/env node
/**
 * Publish a Slide Studio deck into the site at /slides/<slug>/.
 *
 *   node scripts/publish-slides.mjs <deck-dir> [slug]
 *
 * Copies only the deck's runtime files (index.html, css/, js/, slides/,
 * and assets/ if present) into public/slides/<slug>/ — authoring clutter
 * (literature/, tools/, .git, exported PDFs) stays behind. Re-running with
 * the same slug replaces the published copy, so republishing after edits
 * is the same command.
 *
 * The deck is static and relative-pathed, so Astro serves it verbatim from
 * public/. After publishing: commit the new files, then build/deploy as usual.
 */
import fs from 'node:fs';
import path from 'node:path';

const [deckDirArg, slugArg] = process.argv.slice(2);
if (!deckDirArg) {
  console.error('Usage: node scripts/publish-slides.mjs <deck-dir> [slug]');
  process.exit(1);
}

const deckDir = path.resolve(deckDirArg);
const isDeck = (dir) =>
  fs.existsSync(path.join(dir, 'index.html')) &&
  fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes('SLIDE_MANIFEST') &&
  fs.existsSync(path.join(dir, 'slides'));

if (!isDeck(deckDir)) {
  console.error(`Not a Slide Studio deck (no index.html with SLIDE_MANIFEST + slides/): ${deckDir}`);
  process.exit(1);
}

const slug = (slugArg ?? path.basename(deckDir)).toLowerCase().replace(/[_\s]+/g, '-');
if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error(`Slug must be lowercase letters/digits/hyphens, got: ${slug}`);
  process.exit(1);
}

const siteRoot = path.resolve(import.meta.dirname, '..');
const target = path.join(siteRoot, 'public', 'slides', slug);

// Only ever overwrite something that is itself a published deck.
if (fs.existsSync(target)) {
  if (!isDeck(target)) {
    console.error(`Refusing to overwrite ${target} — it exists but doesn't look like a published deck.`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true });
}

const RUNTIME = ['index.html', 'css', 'js', 'slides', 'assets'];
fs.mkdirSync(target, { recursive: true });
for (const entry of RUNTIME) {
  const src = path.join(deckDir, entry);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(target, entry), { recursive: true });
}

const title = fs.readFileSync(path.join(target, 'index.html'), 'utf8')
  .match(/<title>(.*?)<\/title>/)?.[1] ?? slug;
console.log(`Published "${title}" → public/slides/${slug}/`);
console.log(`URL after deploy: /slides/${slug}/`);
console.log(`news.json link:   { "text": "Slides", "url": "/slides/${slug}/" }`);
