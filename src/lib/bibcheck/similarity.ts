/**
 * Text normalization + similarity for comparing bib fields against registry
 * metadata. Deleting (not space-replacing) LaTeX escape debris is the trick
 * that makes 'Schr{\"o}dinger', 'Schr\"odinger', and 'Schrödinger' all
 * collapse to 'schrodinger' without a LaTeX-to-Unicode dependency.
 */

const normalize = (s: string): string =>
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

/**
 * Titles match on Dice ≥ 0.85, or when one normalized title contains the
 * other (subtitle truncation: 'X: a study of Y' vs 'X'). Containment needs
 * the shorter side to be ≥ 3 tokens so 'introduction' can't match everything.
 */
export function titlesMatch(
  a: string,
  b: string,
): { ok: boolean; score: number; containment: boolean } {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return { ok: false, score: 0, containment: false };
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const score = diceTokens(ta, tb);
  const shorter = ta.length <= tb.length ? ta : tb;
  const containment = shorter.length >= 3 && (na.includes(nb) || nb.includes(na));
  return { ok: score >= 0.85 || containment, score, containment };
}

export function familyMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = normalize(a);
  return na !== '' && na === normalize(b);
}
