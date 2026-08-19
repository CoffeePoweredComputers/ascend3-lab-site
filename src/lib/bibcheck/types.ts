/**
 * Bib checker — shared types.
 *
 * Lint issues (missing/malformed data) and verification verdicts (does the
 * entry match what DOI registries say?) are orthogonal: an entry can be
 * `verified` yet missing its pages, or lint-clean yet fabricated.
 */

export type StyleProfile = 'acm' | 'ieee';

export type Severity = 'error' | 'warning' | 'info';

export interface LintIssue {
  /** Citation key; '' for file-level issues (duplicate keys/DOIs/titles). */
  key: string;
  field?: string;
  severity: Severity;
  /** Stable machine code, e.g. 'missing-field', 'doi-as-url', 'pages-hyphen'. */
  code: string;
  message: string;
  /** Suggested replacement value, when the fix is mechanical. */
  fix?: string;
}

export interface BibAuthor {
  family: string;
  given?: string;
}

export interface BibEntry {
  key: string;
  /** Lowercased entry type ('article', 'inproceedings', …). */
  type: string;
  /** Resolved field values (@string expanded, crossref-inherited), lowercased names. */
  fields: Record<string, string>;
  authors: BibAuthor[];
  /** Raw source of this entry — used by lint rules the parser normalizes away. */
  raw: string;
  /** Normalized bare DOI ('10.xxxx/…') when the doi field is valid. */
  doi?: string;
  /** The doi field exactly as written (differs from `doi` when it's a URL). */
  rawDoi?: string;
  /** arXiv id extracted from eprint / 'arXiv preprint' journal / arxiv.org URL. */
  arxivId?: string;
  year?: number;
}

export interface ParseResult {
  entries: BibEntry[];
  /** Parser-reported problems (broken entries, unresolved @string macros). */
  parseErrors: string[];
}

/**
 * Only a definitive 404 from the DOI's authoritative registry may produce
 * 'doi-not-found'. Network trouble is always 'check-failed' — a hallucination
 * checker that blames citations for rate limits has no credibility.
 */
export type VerdictCode =
  | 'verified'
  | 'mismatch'
  | 'doi-not-found'
  | 'found-via-search'
  | 'unverifiable'
  | 'skipped'
  | 'check-failed';

/** What a registry says about a work, reduced to the comparable core. */
export interface RegistryRecord {
  title?: string;
  firstAuthor?: string;
  year?: number;
  doi?: string;
}

export interface Verification {
  key: string;
  verdict: VerdictCode;
  via?: 'crossref' | 'datacite';
  /** Title similarity 0..1, when a comparison happened. */
  score?: number;
  found?: RegistryRecord;
  /** One-line human explanation shown in the row. */
  detail: string;
}
