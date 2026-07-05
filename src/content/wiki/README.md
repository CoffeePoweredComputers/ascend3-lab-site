# Editing the Lab Wiki

Lessons here are **MDX** files: Markdown with optional interactive components. Anyone
with write access to this repository can edit them on github.com — your change builds
and deploys automatically when it lands on `master`.

## How content is organized

```
src/content/wiki/
  <module>/<lesson>.mdx   ← one file per lesson
```

- The **folder name** is the module slug (`irb`, `qualitative`, `quantitative`). It must
  match a `slug` in `src/data/wiki-modules.json`.
- The lesson's URL is `/wiki/<module>/<filename>` (e.g. `irb/overview.mdx` →
  `/wiki/irb/overview`). Use lowercase, hyphenated filenames.

## Frontmatter (the block at the top)

```yaml
---
title: Do I Need IRB Review?     # shown in the sidebar and page heading
module: irb                      # must match the folder + a module slug
order: 2                         # position within the module (1, 2, 3, …)
description: One-line summary.    # optional
estMinutes: 8                    # optional, shown as a time estimate
draft: false                     # optional; drafts are hidden in production
---
```

## Adding a new module

1. Add an entry to `src/data/wiki-modules.json` (`slug`, `title`, `order`, `icon`, `blurb`).
2. Create a folder `src/content/wiki/<slug>/` and add at least one `.mdx` lesson.

## Interactive components

Import what you need at the top of the file, then use it inline:

```mdx
import Callout from '@wiki/Callout.astro';
import Steps from '@wiki/Steps.astro';
import Reveal from '@wiki/Reveal.astro';
import DecisionTree from '@wiki/DecisionTree.astro';
```

| Component | Use it for | Example |
| --- | --- | --- |
| `Callout` | note / tip / warning asides | `<Callout type="tip" title="...">text</Callout>` |
| `Steps` | numbered walkthroughs | wrap a numbered Markdown list in `<Steps>…</Steps>` |
| `Reveal` | click-to-reveal answers | `<Reveal summary="Show answer">…</Reveal>` |
| `DecisionTree` | branching Q&A flows | see `irb/do-i-need-irb.mdx` |

`irb/do-i-need-irb.mdx` and `irb/writing-a-protocol.mdx` are the most complete
examples — copy from them.

### Qualitative-analysis components

The qualitative module adds richer, data-driven widgets. They take structured props;
the running-example data lives in `src/data/qual-example.ts` and is imported into lessons.

| Component | Use it for | Example lesson |
| --- | --- | --- |
| `CodedTranscript` | click-to-reveal coded transcript (code + memo) | `qualitative/initial-coding.mdx` |
| `Codebook` | a code/definition/example/inclusion table | `qualitative/codebook-and-team-coding.mdx` |
| `CodeConsolidation` | many raw codes merging into one | `qualitative/codebook-and-team-coding.mdx` |
| `CodebookMerge` | two coders' codes + agreement highlighting | `qualitative/codebook-and-team-coding.mdx` |
| `ThemeTree` | codes → categories → themes hierarchy | `qualitative/reviewing-defining-themes.mdx` |
| `KappaCalculator` | interactive Cohen's κ + Gwet's AC1 + paradox demo | `qualitative/inter-rater-reliability.mdx` |

### Visualization components (any module)

SVG + vanilla-JS widgets, data-driven via props:

| Component | Use it for | Example lesson |
| --- | --- | --- |
| `ProcessFlow` | clickable stepped flow with detail reveals | `qualitative/overview.mdx` |
| `DistributionPlot` | histogram with live mean/median markers + presets | `quantitative/descriptive-stats.mdx` |
| `SaturationCurve` | new-codes bars + cumulative plateau + a live "codebook so far" | `qualitative/trustworthiness-rigor-saturation.mdx` |
| `SideBySide` | paired two-column comparison (A vs B, row by row) | `qualitative/reviewing-defining-themes.mdx` |
| `MeasureExplorer` | badge list + panel: equation, use case, source per IRR measure | `qualitative/inter-rater-reliability.mdx` |
| `DecisionTree` | branching guide (e.g. "which statistical test?") | `quantitative/overview.mdx`, `irb/do-i-need-irb.mdx` |

### Citations

References live in `src/data/references.json` (one entry per source, with APA text, DOI,
annotation, tags, and a `verified` flag). Cite inline and the link resolves to the
module's references page:

```mdx
import Cite from '@wiki/Cite.astro';

...as established by reflexive TA <Cite id="braun-clarke-2006" />.
Narrative form: <Cite id="cohen-1960" bare /> introduced kappa.
```

Render a tagged bibliography with `<ReferenceList tags={["irr"]} />` (omit `tags` for all).
To add a source, append an object to `references.json` and cite it by `id`.

Prev/next links are added automatically; you don't need to include them in the lesson.

> The interactive components themselves are code (`src/components/wiki/`). To add a new
> *kind* of widget, ask a developer — but editing lesson text and using the existing
> widgets needs nothing but Markdown.
