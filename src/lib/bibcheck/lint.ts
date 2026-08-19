/**
 * Bib checker — style/completeness lint.
 *
 * Required-field tables mirror what the styles' own .bst files warn about
 * (ACM-Reference-Format.bst, IEEEtran.bst); the rest are the hygiene checks
 * that catch Google-Scholar-export junk and hand-typed slips. Rules are
 * tolerance-first: the parser normalizes '--' to an en-dash and months to
 * numbers, so raw-form rules read entry.raw instead of parsed values.
 */
import { diceTokens, titleTokens } from './similarity';
import type { LintIssue, ParseResult, StyleProfile } from './types';

const REQUIRED_BASE: Record<string, string[]> = {
  article: ['author', 'title', 'journal', 'year'],
  inproceedings: ['author', 'title', 'booktitle', 'year'],
  conference: ['author', 'title', 'booktitle', 'year'],
  incollection: ['author', 'title', 'booktitle', 'publisher', 'year'],
  book: ['title', 'publisher', 'year'], // author-or-editor checked separately
  phdthesis: ['author', 'title', 'school', 'year'],
  mastersthesis: ['author', 'title', 'school', 'year'],
  techreport: ['author', 'title', 'institution', 'year'],
  misc: ['title'],
};

// ACM-Reference-Format.bst genuinely requires address for these — the check
// most Google Scholar exports fail.
const ACM_EXTRA: Record<string, string[]> = {
  book: ['address'],
  incollection: ['address'],
};

const JUNK_FIELDS = ['abstract', 'keywords', 'file', 'annote'];
const JUNK_PREFIXES = ['mendeley-', 'bdsk-'];

/** Types worth a DOI warning when none (and no arXiv id) is present. */
const DOI_EXPECTED = new Set(['article', 'inproceedings', 'conference', 'incollection']);

const MONTH_OK_RE =
  /\bmonth\s*=\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b\s*[,}\s]/i;

const INITIALS_ONLY_RE = /^(?:[A-Z]\.[\s-]?)+$/;

/** First (and only first) nesting level of the raw title value, or undefined. */
function rawTitleValue(raw: string): string | undefined {
  const m = /\btitle\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/is.exec(raw);
  return m?.[1];
}

export function lint(result: ParseResult, profile: StyleProfile): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (issue: LintIssue) => issues.push(issue);

  // ── File-level: parser problems ────────────────────────────────────────
  for (const err of result.parseErrors) {
    if (/unresolved @string reference/i.test(err)) {
      push({
        key: '',
        severity: 'info',
        code: 'unresolved-macro',
        message: `${err} — journal-abbreviation macros (e.g. IEEEabrv.bib) defined in another file?`,
      });
    } else {
      push({ key: '', severity: 'error', code: 'parse-error', message: err });
    }
  }

  // ── Per-entry rules ────────────────────────────────────────────────────
  for (const e of result.entries) {
    if (e.type === 'ieeetranbstctl') continue; // IEEEtran control entry, not a citation

    const required = [...(REQUIRED_BASE[e.type] ?? [])];
    if (profile === 'acm') required.push(...(ACM_EXTRA[e.type] ?? []));
    for (const f of required) {
      if (!e.fields[f]?.trim()) {
        push({
          key: e.key,
          field: f,
          severity: 'error',
          code: 'missing-field',
          message: `@${e.type} needs \`${f}\``,
        });
      }
    }
    if (e.type === 'book' && !e.fields.author?.trim() && !e.fields.editor?.trim()) {
      push({
        key: e.key,
        severity: 'error',
        code: 'missing-field',
        message: '@book needs `author` or `editor`',
      });
    }

    if (DOI_EXPECTED.has(e.type) && !e.doi && !e.rawDoi && !e.arxivId) {
      push({
        key: e.key,
        field: 'doi',
        severity: 'warning',
        code: 'missing-doi',
        message:
          profile === 'acm'
            ? 'No DOI — ACM requires DOIs whenever one is assigned'
            : 'No DOI — IEEE prefers references to end with a DOI',
      });
    }

    if (e.rawDoi && !e.doi) {
      push({
        key: e.key,
        field: 'doi',
        severity: 'error',
        code: 'doi-invalid',
        message: `\`${e.rawDoi}\` is not a valid DOI (expected 10.xxxx/…)`,
      });
    } else if (e.rawDoi && e.doi && e.rawDoi.trim() !== e.doi) {
      push({
        key: e.key,
        field: 'doi',
        severity: 'warning',
        code: 'doi-as-url',
        message: 'Store the bare DOI — the style adds the https://doi.org/ link itself',
        fix: e.doi,
      });
    }

    if (profile === 'acm' && e.doi && e.fields.url?.trim()) {
      push({
        key: e.key,
        field: 'url',
        severity: 'warning',
        code: 'url-and-doi',
        message: 'ACM suppresses `url` when `doi` is present — drop the url',
      });
    }

    const pages = e.fields.pages;
    if (pages && /^\s*\d+\s*-\s*\d+\s*$/.test(pages)) {
      push({
        key: e.key,
        field: 'pages',
        severity: 'warning',
        code: 'pages-hyphen',
        message: 'Page ranges use an en-dash: `--` not `-`',
        fix: pages.trim().replace(/\s*-\s*/, '--'),
      });
    }

    if (
      e.authors.some((a) => a.family.toLowerCase() === 'others') ||
      /\bet al\b/i.test(e.fields.author ?? '')
    ) {
      push({
        key: e.key,
        field: 'author',
        severity: 'error',
        code: 'et-al-in-author',
        message: 'List every author — never `and others` / `et al.` in the author field',
      });
    }

    for (const [name, value] of Object.entries(e.fields)) {
      if (value.trim() === '') {
        push({
          key: e.key,
          field: name,
          severity: 'warning',
          code: 'empty-field',
          message: `\`${name}\` is empty — fill it or delete it`,
        });
      }
      if (JUNK_FIELDS.includes(name) || JUNK_PREFIXES.some((p) => name.startsWith(p))) {
        push({
          key: e.key,
          field: name,
          severity: 'info',
          code: 'junk-field',
          message: `\`${name}\` is reference-manager clutter — safe to delete`,
        });
      }
    }

    if (e.type === 'article' && /arxiv preprint/i.test(e.fields.journal ?? '')) {
      push({
        key: e.key,
        field: 'journal',
        severity: 'warning',
        code: 'arxiv-as-journal',
        message:
          'Google-Scholar arXiv export — cite the published version if one exists, else use eprint/archivePrefix fields',
      });
    }
    if (
      ['misc', 'online', 'unpublished'].includes(e.type) &&
      !e.fields.eprint &&
      /arxiv\.org/i.test(`${e.fields.url ?? ''} ${e.fields.howpublished ?? ''}`)
    ) {
      push({
        key: e.key,
        severity: 'warning',
        code: 'arxiv-no-eprint',
        message: 'arXiv reference without `eprint` — add eprint/archivePrefix so it renders as arXiv:ID',
      });
    }

    if (e.fields.month && !MONTH_OK_RE.test(e.raw)) {
      push({
        key: e.key,
        field: 'month',
        severity: 'info',
        code: 'month-format',
        message: 'Use the bare three-letter month macro: `month = mar`, no braces or numbers',
      });
    }

    if (profile === 'acm') {
      const initialsOnly = e.authors.filter((a) => a.given && INITIALS_ONLY_RE.test(a.given));
      if (initialsOnly.length > 0 && initialsOnly.length === e.authors.length) {
        push({
          key: e.key,
          field: 'author',
          severity: 'info',
          code: 'initials-only',
          message: 'ACM prefers full first names (John X. Doe, not J. X. Doe)',
        });
      }
    }

    // Acronym case protection — heuristic, info only. Never flags {{…}}
    // whole-title protection (correct Better BibTeX output).
    const rawTitle = rawTitleValue(e.raw);
    const title = e.fields.title;
    if (rawTitle && title && !rawTitle.startsWith('{')) {
      const unprotected = [
        ...new Set(
          (title.match(/\b[A-Z][A-Z0-9]+\b/g) ?? []).filter(
            (tok) => !new RegExp(`\\{[^{}]*\\b${tok}\\b[^{}]*\\}`).test(rawTitle),
          ),
        ),
      ];
      if (unprotected.length > 0) {
        push({
          key: e.key,
          field: 'title',
          severity: 'info',
          code: 'acronym-braces',
          message: `Brace-protect acronyms so styles can't lowercase them: ${unprotected
            .map((t) => `{${t}}`)
            .join(', ')}`,
        });
      }
    }
  }

  // ── File-level: duplicates ─────────────────────────────────────────────
  const byKey = new Map<string, number>();
  for (const e of result.entries) byKey.set(e.key, (byKey.get(e.key) ?? 0) + 1);
  for (const [key, n] of byKey) {
    if (n > 1) {
      push({
        key: '',
        severity: 'error',
        code: 'dup-key',
        message: `Citation key \`${key}\` appears ${n} times`,
      });
    }
  }

  const byDoi = new Map<string, string[]>();
  for (const e of result.entries) {
    if (e.doi) byDoi.set(e.doi, [...(byDoi.get(e.doi) ?? []), e.key]);
  }
  for (const [doi, keys] of byDoi) {
    if (keys.length > 1) {
      push({
        key: '',
        severity: 'error',
        code: 'dup-doi',
        message: `Same DOI ${doi} in: ${keys.join(', ')} — merge them`,
      });
    }
  }

  const titled = result.entries
    .filter((e) => e.fields.title)
    .map((e) => ({ key: e.key, tokens: titleTokens(e.fields.title) }));
  for (let i = 0; i < titled.length; i++) {
    for (let j = i + 1; j < titled.length; j++) {
      if (titled[i].key === titled[j].key) continue; // already a dup-key error
      if (diceTokens(titled[i].tokens, titled[j].tokens) >= 0.9) {
        push({
          key: '',
          severity: 'warning',
          code: 'near-dup-title',
          message: `\`${titled[i].key}\` and \`${titled[j].key}\` have nearly identical titles — duplicates?`,
        });
      }
    }
  }

  return issues;
}
