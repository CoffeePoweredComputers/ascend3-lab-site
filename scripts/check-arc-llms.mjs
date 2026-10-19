#!/usr/bin/env node
/**
 * ARC LLM guide watcher.
 *
 * The /wiki/computing/arc-llms page reads its model table and OpenCode config
 * from src/data/arc-llms.json. ARC renames and adds models every few months,
 * so this script checks that file against ARC's PUBLIC docs pages — no API key
 * and no campus network needed, which is why it can run as a GitHub Action.
 *
 * It reports (and never edits anything):
 *   - a model id we list that no longer appears on ARC's API page (renamed/removed)
 *   - a model-looking `code` token on that page we don't know about (new model)
 *   - a dated changelog line ("2026/10/17: …") whose date isn't in changelogSeen
 *   - a watched page that fails to load or no longer contains its expected text
 *
 * A human then updates src/data/arc-llms.json (and the lesson prose if needed),
 * bumps `reviewedAt`, and closes the issue. Deliberately not auto-committed: a
 * push to master is a deploy, and scraped HTML is not trustworthy enough to
 * publish unreviewed.
 *
 * Usage: node scripts/check-arc-llms.mjs [--report review.md]
 * (or `npm run check:arc-llms`). Exit 0 = nothing to review, 1 = review needed.
 * With --report, the findings are also written there as Markdown (only when
 * there are any), which the workflow turns into a GitHub issue.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'src/data/arc-llms.json'), 'utf8'));
const reportArg = process.argv.indexOf('--report');
const reportPath = reportArg > -1 ? process.argv[reportArg + 1] : null;

const known = new Set([...data.models.map((m) => m.id), ...data.otherIds, ...data.ignoreTokens]);
const seenDates = new Set(data.changelogSeen.map((line) => line.slice(0, 10)));
const findings = [];

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** HTML → one line of text per block element, whitespace collapsed. */
const toLines = (html) =>
  decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|li|tr|h\d|div|pre|dd|dt)>/gi, '\n'),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

async function fetchPage(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'ascend-lab-wiki-link-check' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

for (const page of data.watch) {
  let html;
  try {
    html = await fetchPage(page.url);
  } catch (e) {
    findings.push(`Could not load ${page.url} (${e.message}). Has ARC moved this page?`);
    continue;
  }
  const lines = toLines(html);
  const text = lines.join('\n');

  for (const s of page.expect) {
    if (!text.includes(s)) {
      findings.push(`${page.url} no longer mentions \`${s}\`. Re-read it against the guide.`);
    }
  }

  if (!page.modelList) continue;

  for (const id of known) {
    if (data.ignoreTokens.includes(id)) continue;
    if (!text.includes(id)) {
      findings.push(`Model \`${id}\` is no longer on ${page.url}. Renamed or retired?`);
    }
  }

  // Model ids are written as inline code on ARC's pages: letters, digits and
  // dots in hyphen-joined parts, with at least one digit (GLM-5.3, gpt-oss-120b).
  const tokens = new Set(
    [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)]
      .map((m) => decode(m[1]).trim())
      .filter((t) => /^[A-Za-z][\w.]*(?:-[\w.]+)+$/.test(t) && /\d/.test(t) && t.length < 60),
  );
  for (const t of tokens) {
    if (!known.has(t)) {
      findings.push(
        `New model-like id \`${t}\` on ${page.url}. Add it to \`models\`/\`otherIds\`, or to \`ignoreTokens\` if it isn't a model.`,
      );
    }
  }

  for (const line of lines) {
    if (/^\d{4}\/\d{2}\/\d{2}:/.test(line) && !seenDates.has(line.slice(0, 10))) {
      findings.push(`New ARC changelog entry: "${line}". Add it to \`changelogSeen\` once handled.`);
    }
  }
}

if (!findings.length) {
  console.log(`✓ ARC LLM guide matches ARC's docs (${data.watch.length} pages checked).`);
  process.exit(0);
}

console.log(`✗ ${findings.length} thing(s) to review:`);
for (const f of findings) console.log(`  - ${f}`);

if (reportPath) {
  writeFileSync(
    reportPath,
    [
      `The daily check found differences between ARC's docs and the [ARC LLM guide](https://ascend3.cs.vt.edu/wiki/computing/arc-llms):`,
      '',
      ...findings.map((f) => `- ${f}`),
      '',
      'To resolve: update `src/data/arc-llms.json` (and `src/content/wiki/computing/arc-llms.mdx` if the steps changed), set `reviewedAt` to today, push, and close this issue.',
      '',
      `_Last checked ${new Date().toISOString().slice(0, 10)}._`,
    ].join('\n'),
  );
}
process.exit(1);
