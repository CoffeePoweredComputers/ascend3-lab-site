/**
 * Bib checker — verify entries against DOI registries.
 *
 * Sequential, deliberately slow pipeline (this is a lab tool, not a product):
 * one request in flight at a time, paced inside Crossref's polite-pool limits,
 * with an in-memory registry cache so re-running after fixes doesn't re-fetch.
 *
 * Crossref-first: ~90% of CS DOIs are Crossref-registered, so the common case
 * is a single request. Only a 404 triggers the doi.org registration-agency
 * lookup that routes to DataCite (which also covers arXiv's 10.48550 DOIs)
 * or declares the DOI unregistered.
 *
 * THE HARD RULE: only a definitive 404 from the authoritative registry may
 * produce 'doi-not-found'. Timeouts, 429-exhaustion, 5xx, network errors →
 * 'check-failed', rendered neutrally. A checker that calls a citation
 * hallucinated because of a rate limit has no credibility.
 */
import { familyMatch, titlesMatch } from './similarity';
import type { BibEntry, RegistryRecord, Verification } from './types';

// Identifies the tool's operator to Crossref's polite pool (lab public contact).
const MAILTO = 'dhsmith4@vt.edu';

const SINGLE_GAP_MS = 350; // single-record lookups (polite pool: 10/s)
const SEARCH_GAP_MS = 1100; // list queries (polite pool: 3/s, concurrency 1)

/** Types worth searching Crossref for when the entry has no DOI. Running
 * bibliographic search on @misc websites/software yields confident-looking
 * garbage matches, so those are 'skipped' instead. */
const SEARCHABLE = new Set(['article', 'inproceedings', 'conference', 'incollection', 'book', 'proceedings']);

/** Network/HTTP trouble — never a verdict about the citation itself. */
class CheckFailed extends Error {}

type RegistryLookup =
  | { kind: 'found'; via: 'crossref' | 'datacite'; record: RegistryRecord }
  | { kind: 'not-found' }
  | { kind: 'unsupported-ra'; ra: string };

// Module-level caches: students fix and re-run repeatedly; don't re-ask the
// registries about DOIs already resolved this session.
const doiCache = new Map<string, RegistryLookup>();
const searchCache = new Map<string, { record?: RegistryRecord; score: number }>();
const raCache = new Map<string, string | undefined>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequest = 0;
async function pace(gapMs: number, signal: AbortSignal): Promise<void> {
  const wait = lastRequest + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  lastRequest = Date.now();
}

/** One retry on 429 honoring Retry-After (capped); anything else non-ok that
 * isn't a 404 throws CheckFailed. Returns the Response (may be a 404). */
async function fetchPaced(url: string, gapMs: number, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await pace(gapMs, signal);
    let res: Response;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new CheckFailed('network error');
    }
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 5000, 30_000));
      continue;
    }
    if (res.status === 429) throw new CheckFailed('rate-limited');
    if (!res.ok && res.status !== 404) throw new CheckFailed(`HTTP ${res.status}`);
    return res;
  }
}

// ── Registry adapters: reduce each API's shape to a RegistryRecord ────────

function fromCrossref(message: any): RegistryRecord {
  return {
    title: message?.title?.[0],
    firstAuthor: message?.author?.find((a: any) => a.sequence === 'first')?.family ?? message?.author?.[0]?.family,
    year:
      message?.issued?.['date-parts']?.[0]?.[0] ??
      message?.['published-print']?.['date-parts']?.[0]?.[0] ??
      message?.['published-online']?.['date-parts']?.[0]?.[0],
    doi: message?.DOI,
  };
}

function fromDataCite(attributes: any): RegistryRecord {
  const creator = attributes?.creators?.[0];
  return {
    title: attributes?.titles?.[0]?.title,
    firstAuthor: creator?.familyName ?? creator?.name?.split(',')[0],
    year: attributes?.publicationYear,
    doi: attributes?.doi,
  };
}

// ── DOI resolution ────────────────────────────────────────────────────────

async function lookupRa(prefix: string, signal: AbortSignal): Promise<string | undefined> {
  if (raCache.has(prefix)) return raCache.get(prefix);
  const res = await fetchPaced(`https://doi.org/ra/${encodeURIComponent(prefix)}`, SINGLE_GAP_MS, signal);
  let ra: string | undefined;
  if (res.ok) {
    const body = await res.json().catch(() => undefined);
    ra = body?.[0]?.RA; // absent (a "status" message instead) for unknown prefixes
  }
  raCache.set(prefix, ra);
  return ra;
}

async function lookupDataCite(doi: string, signal: AbortSignal): Promise<RegistryLookup> {
  const res = await fetchPaced(
    `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
    SINGLE_GAP_MS,
    signal,
  );
  if (res.status === 404) return { kind: 'not-found' };
  const body = await res.json().catch(() => {
    throw new CheckFailed('bad DataCite response');
  });
  return { kind: 'found', via: 'datacite', record: fromDataCite(body?.data?.attributes) };
}

async function lookupDoi(doi: string, signal: AbortSignal): Promise<RegistryLookup> {
  const cached = doiCache.get(doi);
  if (cached) return cached;

  let result: RegistryLookup;
  const prefix = doi.split('/')[0];

  if (prefix === '10.48550') {
    // arXiv DOIs are DataCite-registered; skip the guaranteed Crossref 404.
    result = await lookupDataCite(doi, signal);
  } else {
    const res = await fetchPaced(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`,
      SINGLE_GAP_MS,
      signal,
    );
    if (res.ok) {
      const body = await res.json().catch(() => {
        throw new CheckFailed('bad Crossref response');
      });
      result = { kind: 'found', via: 'crossref', record: fromCrossref(body?.message) };
    } else {
      // 404 from Crossref: ask doi.org who (if anyone) registered this prefix.
      const ra = await lookupRa(prefix, signal);
      if (ra === 'Crossref' || ra === undefined) result = { kind: 'not-found' };
      else if (ra === 'DataCite') result = await lookupDataCite(doi, signal);
      else result = { kind: 'unsupported-ra', ra };
    }
  }

  doiCache.set(doi, result);
  return result;
}

// ── Comparison ────────────────────────────────────────────────────────────

function compare(entry: BibEntry, via: 'crossref' | 'datacite', record: RegistryRecord): Verification {
  const entryTitle = entry.fields.title;
  const entryFamily = entry.authors[0]?.family;

  if (!entryTitle?.trim()) {
    return {
      key: entry.key,
      verdict: 'unverifiable',
      via,
      found: record,
      detail: 'DOI resolves, but the entry has no title to compare against',
    };
  }

  if (!record.title?.trim()) {
    // Some DataCite records carry no usable title — fall back to author + year.
    const ok = familyMatch(entryFamily, record.firstAuthor) && entry.year === record.year;
    return {
      key: entry.key,
      verdict: ok ? 'verified' : 'unverifiable',
      via,
      found: record,
      detail: ok
        ? 'Registry record has no title; author and year match'
        : 'Registry record has no title to compare — check the DOI manually',
    };
  }

  const { ok: titleOk, score } = titlesMatch(entryTitle, record.title);
  const authorOk = familyMatch(entryFamily, record.firstAuthor);
  const yearOk =
    entry.year !== undefined && record.year !== undefined && Math.abs(entry.year - record.year) <= 1;

  if (titleOk && (authorOk || yearOk)) {
    return { key: entry.key, verdict: 'verified', via, score, found: record, detail: 'Registry metadata matches' };
  }
  return {
    key: entry.key,
    verdict: 'mismatch',
    via,
    score,
    found: record,
    detail: titleOk
      ? 'Title matches but author and year both disagree with the registry'
      : 'The DOI resolves to a different work',
  };
}

// ── No-DOI search ─────────────────────────────────────────────────────────

async function searchCrossref(entry: BibEntry, signal: AbortSignal): Promise<Verification> {
  const title = entry.fields.title?.trim();
  const family = entry.authors[0]?.family;
  if (!title || !family || entry.year === undefined) {
    return {
      key: entry.key,
      verdict: 'unverifiable',
      detail: 'Not enough metadata (title + author + year) to search registries — check manually',
    };
  }

  const q = encodeURIComponent(`${title} ${family} ${entry.year}`);
  const url = `https://api.crossref.org/works?query.bibliographic=${q}&rows=3&select=DOI,title,author,issued&mailto=${MAILTO}`;

  const cacheKey = `${title}|${family}|${entry.year}`;
  let best = searchCache.get(cacheKey);
  if (!best) {
    const res = await fetchPaced(url, SEARCH_GAP_MS, signal);
    const body = await res.json().catch(() => {
      throw new CheckFailed('bad Crossref response');
    });
    best = { score: 0 };
    for (const item of body?.message?.items ?? []) {
      const record = fromCrossref(item);
      if (!record.title) continue;
      // Stricter than the DOI path — here we're *choosing* a candidate, so
      // require title (Dice ≥ 0.9 or containment) AND author AND year.
      const { score, containment } = titlesMatch(title, record.title);
      const accept =
        (score >= 0.9 || containment) &&
        familyMatch(family, record.firstAuthor) &&
        record.year !== undefined &&
        Math.abs(entry.year - record.year) <= 1;
      if (accept && (!best.record || score > best.score)) best = { record, score };
      else if (!best.record && score > best.score) best.score = score;
    }
    searchCache.set(cacheKey, best);
  }

  if (best.record) {
    return {
      key: entry.key,
      verdict: 'found-via-search',
      via: 'crossref',
      score: best.score,
      found: best.record,
      detail: `Found on Crossref — add doi = {${best.record.doi}}`,
    };
  }
  return {
    key: entry.key,
    verdict: 'unverifiable',
    score: best.score,
    detail:
      'No confident match on Crossref — needs manual review (theses, workshop papers, and older work are often not indexed)',
  };
}

// ── Entry pipeline ────────────────────────────────────────────────────────

/** Verify one entry — also used for single-entry re-checks and [Retry]. */
export async function verifyOne(entry: BibEntry, signal: AbortSignal): Promise<Verification> {
  const doi = entry.doi ?? (entry.arxivId ? `10.48550/arXiv.${entry.arxivId}` : undefined);

  if (doi) {
    const lookup = await lookupDoi(doi, signal);
    switch (lookup.kind) {
      case 'found':
        return compare(entry, lookup.via, lookup.record);
      case 'not-found':
        return {
          key: entry.key,
          verdict: 'doi-not-found',
          detail: `DOI ${doi} is not registered — fabricated or badly mistyped`,
        };
      case 'unsupported-ra':
        return {
          key: entry.key,
          verdict: 'unverifiable',
          detail: `DOI is registered with ${lookup.ra}, which this tool can't query — check https://doi.org/${doi} manually`,
        };
    }
  }

  if (SEARCHABLE.has(entry.type)) return searchCrossref(entry, signal);

  if (['phdthesis', 'mastersthesis', 'techreport'].includes(entry.type)) {
    return {
      key: entry.key,
      verdict: 'unverifiable',
      detail: `@${entry.type} is rarely registry-indexed — verify manually (institution's repository, library catalog)`,
    };
  }

  return {
    key: entry.key,
    verdict: 'skipped',
    detail: `@${entry.type} without a DOI isn't registry-indexed — nothing to check against`,
  };
}

/** Crossref title search ignoring the entry's (possibly bogus) DOI — the
 * "find the correct DOI" action for fabrication triage. */
export function searchForDoi(entry: BibEntry, signal: AbortSignal): Promise<Verification> {
  return searchCrossref({ ...entry, doi: undefined, arxivId: undefined }, signal);
}

export interface VerifyOptions {
  signal: AbortSignal;
  onResult: (done: number, total: number, v: Verification) => void;
}

/**
 * Verify entries one at a time. Resolves with the verifications completed so
 * far when aborted; individual failures become 'check-failed' verdicts.
 */
export async function verifyAll(entries: BibEntry[], opts: VerifyOptions): Promise<Verification[]> {
  const out: Verification[] = [];
  for (const entry of entries) {
    if (opts.signal.aborted) break;
    let v: Verification;
    try {
      v = await verifyOne(entry, opts.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') break;
      v = {
        key: entry.key,
        verdict: 'check-failed',
        detail: `Couldn't check (${err instanceof CheckFailed ? err.message : 'unexpected error'}) — try again`,
      };
    }
    out.push(v);
    opts.onResult(out.length, entries.length, v);
  }
  return out;
}
