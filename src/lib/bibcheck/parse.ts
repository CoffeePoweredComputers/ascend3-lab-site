/**
 * Bib checker — parse a .bib source string into BibEntry[].
 *
 * Wraps @retorquere/bibtex-parser (the Better BibTeX parser). It resolves
 * @string macros and crossref inheritance itself, and with
 * `sentenceCase: false` leaves the author's title casing alone. It still
 * normalizes some values (months → numbers, '--' → en-dash, braces stripped),
 * so lint rules that care about the raw form read `entry.raw` instead.
 */
import { parse as parseBibtex, type Creator, type FieldValue } from '@retorquere/bibtex-parser';
import type { BibAuthor, BibEntry, ParseResult } from './types';

const MAX_BYTES = 1_000_000;
const MAX_ENTRIES = 300;

/** Input the tool refuses to process (too big, not BibTeX at all). */
export class BibInputError extends Error {}

const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/** Strip https://doi.org/ / doi: prefixes; return the bare DOI if valid. */
export function normalizeDoi(value: string): string | undefined {
  const bare = value
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
    .replace(/[.,;]+$/, '');
  return DOI_RE.test(bare) ? bare : undefined;
}

const ARXIV_NEW = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const ARXIV_OLD = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i;

function extractArxivId(fields: Record<string, string>): string | undefined {
  const eprint = fields.eprint?.trim();
  if (eprint) {
    const id = eprint.replace(/^arxiv:/i, '');
    if (ARXIV_NEW.test(id) || ARXIV_OLD.test(id)) return id;
  }
  // Google Scholar's signature mangling: journal = {arXiv preprint arXiv:1706.03762}
  const inline = /arxiv:\s*([a-z0-9./-]+)/i.exec(
    `${fields.journal ?? ''} ${fields.note ?? ''} ${fields.howpublished ?? ''}`,
  );
  if (inline) {
    const id = inline[1].replace(/[.,;]+$/, '');
    if (ARXIV_NEW.test(id) || ARXIV_OLD.test(id)) return id;
  }
  const url = /arxiv\.org\/(?:abs|pdf)\/([^\s{}]+?)(?:\.pdf)?$/i.exec(fields.url ?? '');
  if (url) {
    const id = url[1].replace(/v\d+$/, '');
    if (ARXIV_NEW.test(id) || ARXIV_OLD.test(id)) return id;
  }
  return undefined;
}

/** The parser's entry.input glues trailing % comments (up to the next entry)
 * onto the block. Strip them so `raw` ends at the entry's closing brace —
 * otherwise removing an entry would eat the comment after it, and a `}` inside
 * a comment would corrupt field insertion. */
const trimTrailingComments = (input: string): string =>
  input.replace(/(\r?\n[ \t]*%[^\n]*)+[ \t]*$/, '').trimEnd();

const isCreatorList = (v: FieldValue): v is Creator[] =>
  Array.isArray(v) && v.length > 0 && typeof v[0] === 'object';

const creatorToString = (c: Creator): string =>
  c.name ?? [c.lastName, c.firstName].filter(Boolean).join(', ');

function fieldToString(value: FieldValue): string {
  if (typeof value === 'string') return value;
  if (isCreatorList(value)) return value.map(creatorToString).join(' and ');
  return (value as string[]).join(' and ');
}

export function parseBib(source: string): ParseResult {
  if (new Blob([source]).size > MAX_BYTES) {
    throw new BibInputError('That file is over 1 MB — this tool is for paper bibliographies, not databases.');
  }

  const bib = parseBibtex(source, { sentenceCase: false });

  if (bib.entries.length === 0 && bib.errors.length === 0) {
    throw new BibInputError('No BibTeX entries found — is this a .bib file?');
  }
  if (bib.entries.length > MAX_ENTRIES) {
    throw new BibInputError(`${bib.entries.length} entries is over the ${MAX_ENTRIES}-entry limit — split the file.`);
  }

  const entries: BibEntry[] = bib.entries.map((e) => {
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(e.fields)) {
      fields[name.toLowerCase()] = fieldToString(value);
    }

    const authorsRaw = e.fields.author;
    const authors: BibAuthor[] = isCreatorList(authorsRaw)
      ? authorsRaw.map((c) => ({ family: c.lastName ?? c.name ?? '', given: c.firstName }))
      : [];

    const rawDoi = fields.doi;
    const year = Number.parseInt(fields.year ?? '', 10);

    return {
      key: e.key,
      type: e.type.toLowerCase(),
      fields,
      authors,
      raw: trimTrailingComments(e.input),
      doi: rawDoi ? normalizeDoi(rawDoi) : undefined,
      rawDoi,
      arxivId: extractArxivId(fields),
      year: Number.isFinite(year) ? year : undefined,
    };
  });

  const parseErrors = [...new Set(bib.errors.map((err) => err.error))];

  return { entries, parseErrors };
}
