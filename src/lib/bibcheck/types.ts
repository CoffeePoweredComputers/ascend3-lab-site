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
  /** DOI resolves to a different work (title disagrees). */
  | 'mismatch'
  /** Right work (title agrees) but authors / year / pages disagree with the
   * registry — the "real paper, hallucinated details" pattern. */
  | 'details-mismatch'
  | 'doi-not-found'
  | 'found-via-search'
  | 'unverifiable'
  | 'skipped'
  | 'check-failed';

export interface RegistryAuthor {
  family?: string;
  given?: string;
  suffix?: string;
  /** Organisation / single-string name when the registry has no family name. */
  name?: string;
}

/** What a registry says about a work, reduced to the comparable core. */
export interface RegistryRecord {
  /** Main title plus subtitle when the registry stores them split. */
  title?: string;
  /** Main title alone, when a subtitle was split off. */
  titleBare?: string;
  firstAuthor?: string;
  authors?: RegistryAuthor[];
  year?: number;
  doi?: string;
  /** Page range as the registry gives it ('417-423'). */
  pages?: string;
  container?: string;
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
  /** details-mismatch: each field-level disagreement, human-readable. */
  problems?: string[];
  /** details-mismatch: BibTeX field values from the registry that would
   * resolve `problems` (author, year, pages, and doi on the search path). */
  suggested?: Record<string, string>;
}
