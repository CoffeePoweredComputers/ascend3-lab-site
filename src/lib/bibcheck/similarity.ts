/**
 * Text normalization + similarity for comparing bib fields against registry
 * metadata. Deleting (not space-replacing) LaTeX escape debris is the trick
 * that makes 'Schr{\"o}dinger', 'Schr\"odinger', and 'Schrödinger' all
 * collapse to 'schrodinger' without a LaTeX-to-Unicode dependency.
 */
import type { RegistryRecord } from './types';

export const normalize = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\\[a-z]+/g, '')
    .replace(/[{}\\"'^~=]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const titleTokens = (s: string): string[] => normalize(s).split(' ').filter(Boolean);

/** Token-set Dice coefficient, 0..1. */
export function diceTokens(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common += 1;
  return (2 * common) / (setA.size + setB.size);
}

export interface TitleMatch {
  ok: boolean;
  score: number;
  containment: boolean;
}

/**
 * Titles match on Dice ≥ 0.85, or when one normalized title contains the
 * other (subtitle truncation: 'X: a study of Y' vs 'X'). Containment is
 * deliberately narrow: the shorter side needs ≥ 4 tokens AND ≥ 40% of the
 * longer side's tokens, so a generic fragment ('parsons problems in cs1')
 * can't ride on any paper whose title happens to contain it.
 */
export function titlesMatch(a: string, b: string): TitleMatch {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return { ok: false, score: 0, containment: false };
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const score = diceTokens(ta, tb);
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const containment =
    shorter.length >= 4 &&
    shorter.length / longer.length >= 0.4 &&
    (na.includes(nb) || nb.includes(na));
  return { ok: score >= 0.85 || containment, score, containment };
}

/** Best title match against a registry record, trying the joined
 * title+subtitle and the bare main title (Springer, IEEE, and Elsevier
 * store subtitles separately; ACM doesn't). */
export function bestTitleMatch(entryTitle: string, record: RegistryRecord): TitleMatch {
  const candidates = [record.title, record.titleBare].filter((t): t is string => !!t?.trim());
  let best: TitleMatch = { ok: false, score: 0, containment: false };
  for (const t of candidates) {
    const m = titlesMatch(entryTitle, t);
    if (m.ok && !best.ok) best = m;
    else if (m.ok === best.ok && m.score > best.score) best = m;
  }
  return best;
}

/**
 * Family names match when equal after normalization, or when one is the
 * other plus leading particles ('van der Berg' vs 'Berg') — parsers and
 * registries disagree on where particles live.
 */
export function familyMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(` ${nb}`) || nb.endsWith(` ${na}`);
}

const firstInitial = (given: string): string | undefined => /[a-z]/.exec(normalize(given))?.[0];

/** Given names agree when their first initials agree. Either side missing
 * or initial-less counts as agreement — registries often carry initials
 * only, and an absent given name is a lint matter, not a fabrication. */
export function givenMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  const ia = firstInitial(a);
  const ib = firstInitial(b);
  return !ia || !ib || ia === ib;
}

/** '417--423', '417 – 423', '417-423' → '417-423'. Undefined when the value
 * isn't a plain page range (article numbers, 'e12345', 'Article 53'). */
export function normalizePages(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const s = p
    .normalize('NFKD')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/\s+/g, '')
    .replace(/-+/g, '-');
  return /^\d+(?:-\d+)?$/.test(s) ? s : undefined;
}
