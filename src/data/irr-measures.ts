/**
 * Inter-rater reliability measures shown in the MeasureExplorer widget.
 * `formula` and `where` are author-written HTML (Unicode symbols + <sub> + the
 * .wiki-eq__frac fraction helper) — rendered with set:html in the component.
 * Equations verified against the primary/standard sources (Crossref + texts).
 */
export type IrrMeasure = {
  id: string;
  name: string;
  citeIds: string[];
  formula: string;
  where: string;
  explanation: string;
  useCase: string;
};

const frac = (num: string, den: string) =>
  `<span class="wiki-eq__frac"><span class="wiki-eq__num">${num}</span><span class="wiki-eq__den">${den}</span></span>`;

export const irrMeasures: IrrMeasure[] = [
  {
    id: 'cohen-1960',
    name: "Cohen's κ",
    citeIds: ['cohen-1960'],
    formula: `κ = ${frac('p<sub>o</sub> − p<sub>e</sub>', '1 − p<sub>e</sub>')}`,
    where: 'p<sub>o</sub> = observed agreement; p<sub>e</sub> = agreement expected by chance, from <em>each</em> coder’s own category rates.',
    explanation:
      'Observed agreement minus what two coders would reach by chance, rescaled by the room left above chance.',
    useCase: 'Two coders, unordered (nominal) categories.',
  },
  {
    id: 'cohen-1968',
    name: 'Weighted κ',
    citeIds: ['cohen-1968'],
    formula: `κ<sub>w</sub> = 1 − ${frac('Σ w<sub>ij</sub> o<sub>ij</sub>', 'Σ w<sub>ij</sub> e<sub>ij</sub>')}`,
    where: 'w<sub>ij</sub> = disagreement weight between categories i and j; o<sub>ij</sub> / e<sub>ij</sub> = observed / expected counts.',
    explanation:
      'Disagreements are penalised in proportion to how far apart the categories are, so near-misses cost less than gross errors.',
    useCase: 'Two coders, ordered (ordinal) categories where some disagreements are worse than others.',
  },
  {
    id: 'scott-1955',
    name: "Scott's π",
    citeIds: ['scott-1955'],
    formula: `π = ${frac('p<sub>o</sub> − p<sub>e</sub>', '1 − p<sub>e</sub>')}`,
    where: 'p<sub>e</sub> = Σ p̄<sub>k</sub>², using the <em>pooled</em> category proportions p̄<sub>k</sub> shared across both coders.',
    explanation:
      'Like kappa, but chance is estimated from one shared category distribution (the pooled marginals) rather than each coder’s own.',
    useCase: 'Two coders, nominal — a simple alternative to kappa using pooled chance.',
  },
  {
    id: 'fleiss-1971',
    name: "Fleiss' κ",
    citeIds: ['fleiss-1971'],
    formula: `κ = ${frac('P̄ − P̄<sub>e</sub>', '1 − P̄<sub>e</sub>')}`,
    where: 'P̄ = mean per-item agreement across coders; P̄<sub>e</sub> = Σ p<sub>j</sub>² over all category assignments.',
    explanation:
      "Scott's π generalised to any number of coders — agreement is averaged over items and corrected for the overall category split.",
    useCase: 'Three or more coders, nominal (coders need not be the same across items).',
  },
  {
    id: 'hayes-krippendorff-2007',
    name: "Krippendorff's α",
    citeIds: ['hayes-krippendorff-2007'],
    formula: `α = 1 − ${frac('D<sub>o</sub>', 'D<sub>e</sub>')}`,
    where: 'D<sub>o</sub> = observed disagreement; D<sub>e</sub> = disagreement expected by chance, via a difference function δ matched to the data’s level.',
    explanation:
      'Works on disagreement: one minus the ratio of observed to expected disagreement, with δ chosen for nominal, ordinal, or interval data.',
    useCase: 'Any measurement level, two or more coders, and/or missing data — the most general single coefficient.',
  },
  {
    id: 'gwet-2008',
    name: "Gwet's AC1",
    citeIds: ['gwet-2008'],
    formula: `AC1 = ${frac('p<sub>o</sub> − p<sub>e</sub>', '1 − p<sub>e</sub>')}`,
    where: `p<sub>e</sub> = ${frac('1', 'q − 1')} · Σ π<sub>k</sub>(1 − π<sub>k</sub>); q = number of categories; π<sub>k</sub> = mean proportion classified into category k.`,
    explanation:
      'Same shape as kappa, but the chance term shrinks when one category dominates, so high agreement is no longer punished by skew.',
    useCase: 'Skewed / high-prevalence coding where kappa is paradoxically low despite high agreement.',
  },
  {
    id: 'shrout-fleiss-1979',
    name: 'ICC',
    citeIds: ['shrout-fleiss-1979', 'mcgraw-wong-1996', 'koo-li-2016'],
    formula: `ICC = ${frac('MS<sub>b</sub> − MS<sub>w</sub>', 'MS<sub>b</sub> + (k − 1)·MS<sub>w</sub>')}`,
    where: 'MS<sub>b</sub> / MS<sub>w</sub> = between-target / within-target mean squares; k = number of raters. (One-way form; six ICC variants exist.)',
    explanation:
      'The share of total variance reflecting real differences between targets rather than rater noise; the exact form depends on your design.',
    useCase: 'Continuous or interval ratings rather than categories.',
  },
];
