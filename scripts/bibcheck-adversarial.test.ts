/**
 * Adversarial cases for the bib checker's verification layer
 * (`npm run test:bibcheck`). fetch is mocked with canned registry records,
 * so it runs offline and deterministically.
 *
 * Origin: a real bibliography carried "Brent Smith, Suzanne Fowler, and
 * Craig Zilles … pp. 179–185" for a paper whose registry record says
 * "David H. Smith IV, Max Fowler, Craig Zilles … pp. 417–423". Title, DOI,
 * venue, and year were all right, and the checker passed it: it only ever
 * compared title + first-author family + year. These cases pin down that
 * pattern (real paper, invented details) and its neighbours.
 *
 * Each case: a BibTeX entry an LLM might plausibly emit, the registry truth,
 * and the verdict a careful human would give.
 */
import { parseBib } from '@lib/bibcheck/parse';
import { verifyOne } from '@lib/bibcheck/verify';

// ── Canned registry ───────────────────────────────────────────────────────
const cr = (doi: string, title: string, authors: [string, string, string?][], year: number, page?: string, subtitle?: string, container?: string) => ({
  DOI: doi,
  title: [title],
  subtitle: subtitle ? [subtitle] : [],
  author: authors.map(([given, family, suffix], i) => ({ given, family, suffix, sequence: i === 0 ? 'first' : 'additional' })),
  issued: { 'date-parts': [[year, 6, 29]] },
  page,
  'container-title': container ? [container] : [],
});

const CROSSREF: Record<string, any> = {
  '10.1145/3587102.3588819': cr('10.1145/3587102.3588819',
    'Investigating the Role and Impact of Distractors on Parsons Problems in CS1 Assessments',
    [['David H.', 'Smith', 'IV'], ['Max', 'Fowler'], ['Craig', 'Zilles']], 2023, '417-423', undefined,
    'Proceedings of the 2023 Conference on Innovation and Technology in Computer Science Education V. 1'),
  '10.1145/3373165.3373187': cr('10.1145/3373165.3373187',
    'A Review of Research on Parsons Problems',
    [['Yi', 'Du'], ['Andrew', 'Luxton-Reilly'], ['Paul', 'Denny']], 2020, '195-202'),
  '10.1145/3411764.3445228': cr('10.1145/3411764.3445228',
    'Improving Instruction of Programming Patterns with Faded Parsons Problems',
    [['Nathaniel', 'Weinman'], ['Armando', 'Fox'], ['Marti A.', 'Hearst']], 2021),
  // Springer-style split title/subtitle
  '10.1007/s11409-020-09999-x': cr('10.1007/s11409-020-09999-x',
    'Pulla', [['Ada', 'Lovelace']], 2020, '1-12', 'A Parsons Problem Tool for Fine-Grained Behavioral Tracing'),
  // particle surname
  '10.1145/1111111.2222222': cr('10.1145/1111111.2222222',
    'Teaching Recursion with Visual Traces in a Large Introductory Course',
    [['Jan', 'van der Berg'], ['Marie', 'Curie']], 2019, '10-18'),
  // the volume DOI, not a paper
  '10.1145/3587102': cr('10.1145/3587102',
    'Proceedings of the 2023 Conference on Innovation and Technology in Computer Science Education V. 1', [], 2023),
  // Different-paper, same first author + year as the Smith entry
  '10.1145/3545945.3569764': cr('10.1145/3545945.3569764',
    'Early Experiences With Parsons Problems as Formative Assessment in CS1 Laboratories',
    [['David H.', 'Smith', 'IV'], ['Craig', 'Zilles']], 2023, '1-7'),
  // Organisation author only
  '10.1000/org.1': cr('10.1000/org.1', 'Computing Curricula 2020 Paradigms for Global Computing Education', [], 2020),
};
(CROSSREF['10.1000/org.1'].author = [{ name: 'ACM Joint Task Force', sequence: 'first' }]);

const DATACITE: Record<string, any> = {
  '10.48550/arxiv.2605.13532': {
    data: { attributes: { doi: '10.48550/arXiv.2605.13532', titles: [{ title: 'AI-Generated Slides: Are They Good? Can Students Tell?' }],
      creators: [{ givenName: 'Juho', familyName: 'Leinonen' }, { givenName: 'Lisa', familyName: 'Zhang' }, { givenName: 'Arto', familyName: 'Hellas' }],
      publicationYear: 2026 } },
  },
};

// Search index: title-keyed, for query.bibliographic
const SEARCHABLE_WORKS = Object.values(CROSSREF);

globalThis.fetch = (async (input: any) => {
  const url = String(input);
  const json = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let m: RegExpExecArray | null;
  if ((m = /api\.crossref\.org\/works\/([^?]+)/.exec(url))) {
    const doi = decodeURIComponent(m[1]);
    const rec = CROSSREF[doi];
    return rec ? json({ message: rec }) : json({ status: 'error' }, 404);
  }
  if (/api\.crossref\.org\/works\?/.test(url)) {
    const q = decodeURIComponent(new URL(url).searchParams.get('query.bibliographic') ?? '').toLowerCase();
    const words = q.split(/\W+/).filter((w) => w.length > 3);
    const scored = SEARCHABLE_WORKS.map((w) => ({
      w,
      s: words.filter((x) => String(w.title[0]).toLowerCase().includes(x)).length,
    })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
    return json({ message: { items: scored.map((x) => x.w) } });
  }
  if ((m = /doi\.org\/ra\/(.+)$/.exec(url))) {
    const prefix = decodeURIComponent(m[1]);
    if (prefix === '10.48550') return json([{ DOI: prefix, RA: 'DataCite' }]);
    if (prefix.startsWith('10.1145') || prefix.startsWith('10.1007') || prefix.startsWith('10.1000')) return json([{ DOI: prefix, RA: 'Crossref' }]);
    return json([{ DOI: prefix, status: 'Invalid DOI' }]);
  }
  if ((m = /api\.datacite\.org\/dois\/(.+)$/.exec(url))) {
    const doi = decodeURIComponent(m[1]).toLowerCase();
    const rec = DATACITE[doi];
    return rec ? json(rec) : json({ errors: [] }, 404);
  }
  throw new Error(`unmocked url ${url}`);
}) as any;

// ── Cases ─────────────────────────────────────────────────────────────────
interface Case { name: string; bib: string; expect: string; why: string }

const SMITH = (over: Partial<Record<'author' | 'year' | 'pages' | 'title' | 'doi' | 'booktitle', string | null>> = {}) => {
  const f: Record<string, string | null> = {
    author: 'Smith, David H. and Fowler, Max and Zilles, Craig',
    title: 'Investigating the Role and Impact of Distractors on Parsons Problems in CS1 Assessments',
    booktitle: 'ITiCSE 2023',
    year: '2023',
    pages: '417--423',
    doi: '10.1145/3587102.3588819',
    ...over,
  };
  return `@inproceedings{smith2023,\n${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `  ${k} = {${v}},`).join('\n')}\n}`;
};

const CASES: Case[] = [
  { name: 'control: fully correct entry', bib: SMITH(), expect: 'verified', why: 'baseline' },
  { name: 'A1 given names invented (Brent Smith, Suzanne Fowler)', bib: SMITH({ author: 'Smith, Brent and Fowler, Suzanne and Zilles, Craig' }), expect: 'details-mismatch', why: 'the real Pulla-paper case' },
  { name: 'A2 pages invented', bib: SMITH({ pages: '179--185' }), expect: 'details-mismatch', why: 'pages 417-423 on the registry' },
  { name: 'A3 co-author dropped', bib: SMITH({ author: 'Smith, David H. and Zilles, Craig' }), expect: 'details-mismatch', why: 'Fowler missing' },
  { name: 'A4 co-author invented', bib: SMITH({ author: 'Smith, David H. and Fowler, Max and Denny, Paul and Zilles, Craig' }), expect: 'details-mismatch', why: 'Denny is not on the paper' },
  { name: 'A5 author order swapped (first author wrong, year right)', bib: SMITH({ author: 'Zilles, Craig and Fowler, Max and Smith, David H.' }), expect: 'details-mismatch', why: 'old code: year rescues a wrong first author' },
  { name: 'A6 year off by 3, authors right', bib: SMITH({ year: '2020' }), expect: 'details-mismatch', why: 'old code: author rescues a wrong year' },
  { name: 'A7 year off by 1 (online vs print)', bib: SMITH({ year: '2024' }), expect: 'verified', why: 'tolerated' },
  { name: 'A8 initials only, correct', bib: SMITH({ author: 'Smith, D. H. and Fowler, M. and Zilles, C.' }), expect: 'verified', why: 'initials agree' },
  { name: 'A9 initials only, wrong', bib: SMITH({ author: 'Smith, B. and Fowler, S. and Zilles, C.' }), expect: 'details-mismatch', why: 'B≠D, S≠M' },
  { name: 'A10 suffix written BibTeX-style', bib: SMITH({ author: 'Smith, IV, David H. and Fowler, Max and Zilles, Craig' }), expect: 'verified', why: 'Jr-style suffix' },
  { name: 'A11 et al. truncation', bib: SMITH({ author: 'Smith, David H. and others' }), expect: 'verified', why: 'prefix compare only; lint flags the et al.' },
  { name: 'A12 pages as en-dash with spaces', bib: SMITH({ pages: '417 – 423' }), expect: 'verified', why: 'page normalisation' },
  { name: 'A13 title word substituted (CS1 → CS2)', bib: SMITH({ title: 'Investigating the Role and Impact of Distractors on Parsons Problems in CS2 Assessments' }), expect: 'verified', why: 'Dice tolerance keeps minor title drift as lint-level; accepted' },
  { name: 'B1 DOI of a different Smith/Zilles 2023 paper', bib: SMITH({ doi: '10.1145/3545945.3569764' }), expect: 'mismatch', why: 'title fails' },
  { name: 'B2 DOI of the proceedings volume', bib: SMITH({ doi: '10.1145/3587102' }), expect: 'mismatch', why: 'container, not paper' },
  { name: 'C1 generic 3-token title contained in a real title', bib: `@inproceedings{x,\n  author = {Smith, David H.},\n  title = {Parsons Problems in CS1},\n  booktitle = {ITiCSE},\n  year = {2023},\n  doi = {10.1145/3587102.3588819},\n}`, expect: 'mismatch', why: 'old code: containment with 3 tokens + year passes' },
  { name: 'C2 subtitle split on registry (Springer style)', bib: `@article{pulla,\n  author = {Lovelace, Ada},\n  title = {Pulla: A Parsons Problem Tool for Fine-Grained Behavioral Tracing},\n  journal = {J. Educ. Comput.},\n  year = {2020},\n  pages = {1--12},\n  doi = {10.1007/s11409-020-09999-x},\n}`, expect: 'verified', why: 'old code: registry title "Pulla" alone → mismatch false positive' },
  { name: 'C3 particle surname', bib: `@inproceedings{vdb,\n  author = {van der Berg, Jan and Curie, Marie},\n  title = {Teaching Recursion with Visual Traces in a Large Introductory Course},\n  booktitle = {SIGCSE},\n  year = {2019},\n  pages = {10--18},\n  doi = {10.1145/1111111.2222222},\n}`, expect: 'verified', why: 'parser splits particle from family' },
  { name: 'C4 organisation author on registry', bib: `@misc{cc2020,\n  author = {{ACM Joint Task Force}},\n  title = {Computing Curricula 2020 Paradigms for Global Computing Education},\n  year = {2020},\n  doi = {10.1000/org.1},\n}`, expect: 'verified', why: 'no family names to compare — do not fail' },
  { name: 'D1 no DOI, real title, invented authors', bib: SMITH({ doi: null, author: 'Brent, Smith and Fowler, Suzanne' }), expect: 'details-mismatch', why: 'old code: unverifiable "not indexed"; should say the paper exists with other authors' },
  { name: 'D2 no DOI, real title, correct', bib: SMITH({ doi: null }), expect: 'found-via-search', why: 'add-DOI path' },
  { name: 'D3 no DOI, real title, wrong first name', bib: SMITH({ doi: null, author: 'Smith, Brent and Fowler, Max and Zilles, Craig' }), expect: 'details-mismatch', why: 'old code: found-via-search then stamped verified' },
  { name: 'E1 arXiv eprint with version suffix', bib: `@misc{lein,\n  author = {Leinonen, Juho and Zhang, Lisa and Hellas, Arto},\n  title = {AI-Generated Slides: Are They Good? Can Students Tell?},\n  year = {2026},\n  eprint = {2605.13532v2},\n  archivePrefix = {arXiv},\n}`, expect: 'verified', why: 'old code: constructs 10.48550/arXiv.2605.13532v2 → DataCite 404 → FALSE "not registered"' },
  { name: 'E2 arXiv real id, invented authors', bib: `@misc{lein2,\n  author = {Leinonen, Juho and Hellas, Arto},\n  title = {AI-Generated Slides: Are They Good? Can Students Tell?},\n  year = {2026},\n  eprint = {2605.13532},\n}`, expect: 'details-mismatch', why: 'Zhang dropped' },
  { name: 'F1 unregistered DOI', bib: SMITH({ doi: '10.1145/9999999.9999999' }), expect: 'doi-not-found', why: 'the classic' },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const { entries } = parseBib(c.bib);
  const v = await verifyOne(entries[0], new AbortController().signal);
  const ok = v.verdict === c.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      got ${v.verdict}${ok ? '' : `, want ${c.expect}`} — ${v.detail}${v.problems?.length ? `\n      problems: ${v.problems.join(' | ')}` : ''}`);
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
