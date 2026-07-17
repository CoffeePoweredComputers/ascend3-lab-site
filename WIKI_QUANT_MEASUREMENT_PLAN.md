# Wiki Plan: Quantitative Analysis (single module, with Measurement & IRT)

Plan for filling out the `quantitative` module. Written 2026-07-17, revised same day:
**one module, not two** — measurement/IRT lives inside `quantitative` as sidebar groups
(the `group` frontmatter mechanism already used for Path A/B in qualitative). If the
module ever feels too big in practice, splitting later is mechanical: move the
measurement lessons to a new folder and change their `module:` field. Decide then.

Grounding: a literature sweep of (1) which quantitative methods actually appear in CER
venues, (2) the standard CTT→IRT sequence from psychometrics courses/textbooks, and
(3) the validated-instrument landscape in computing education. Key sources at the end.

---

## Shape of the module

18 lessons + references, in five blocks:

```
overview, descriptive-stats            (ungrouped, orders 1–2)
Inference                              (orders 3–4)
Comparing groups                       (orders 5–6)
Regression & modeling                  (orders 7–11)  ← full regression family, GEE, SEM
Measurement & IRT                      (orders 12–18) ← the heavy block
references                             (order 19)
```

That is bigger than qualitative (11) but everything is consolidated hard — merging
further would mean cutting content, not packaging. If trimming is ever needed, the
first candidates are merging 3+4, merging 9 back into 8, and folding 17 into 16.

Two framing commitments run throughout:

- **Validity is a property of score interpretations for uses, not of instruments.**
  "The SCS1 is validated" is the canonical student error.
- **Sample-size honesty.** Course-sized samples (N < 200) support CTT or Rasch, not
  2PL/3PL; SEM wants N in the hundreds; GEE wants ~30+ clusters, so two course sections
  don't qualify. Say so instead of teaching machinery students can't defensibly run.

A third thread the module owes its readers: **results must be communicable to
non-statisticians** — instructors, advisors, reviewers. This peaks in the logistic
lesson (log-odds are unreadable; the lesson is built around the translation problem)
but the effect-sizes lesson sets it up and every modeling lesson ends with a
"reporting this" beat.

Two recurring elements run through the lessons (each has its own section below, and
full authored content lives in `WIKI_QUANT_PLAN_APPENDIX.md`):

- **Interactive question walkthroughs** (`ScenarioWalkthrough`) — scenario-based
  "which analysis and why" trainers where every option gives feedback.
- **GenAI toolboxes** (`GenAiToolbox`) — per-lesson worked examples of using LLMs
  according to best practice, anchored by a module-wide ground-rules box.

Registry: `quantitative` keeps its slug and order. Update the blurb to cover the new
scope, e.g. "From descriptive stats through regression, SEM, and IRT — analysis and
measurement you can trust." Drop `underConstruction` when the first block ships.
(`research-design` still says "& Measurement" in its title; with the heavy treatment
living here, its planned validity bullet should be a primer that links here — one line,
decide when that module gets written.)

---

## The debugging throughline

The wiki already runs on debugging: qualitative codes interviews with intro-CS students
about debugging; PM's example project is a debugging study. This module continues the
thread, and a real research hook makes it more than narrative:

> **As of 2026 there is no widely accepted validated debugging knowledge assessment or
> debugging concept inventory.** The TOCE 2024 systematic review of debugging
> interventions (Yang et al.) found outcome measures are almost all ad hoc. There is
> also no standalone validated debugging self-efficacy scale — studies adapt the Debug
> subscale of Tsai et al. (2019) or Michaeli & Romeike's (2019) items.

Two running artifacts, one study:

- **A debugging-intervention study** (stats lessons 2–11): one section taught a
  systematic debugging process vs a comparison section, pre/post exercises — directly
  echoing Michaeli & Romeike (2019), which is citable. It naturally emits every data
  type the lessons need: time-to-fix (right-skewed → descriptives), fixed/not-fixed per
  exercise (binary → logistic; repeated per student → GEE), pre/post scores (paired
  tests), two sections (nesting honesty), Likert self-efficacy (ordinal outcomes), and
  a mediation story for SEM (instruction → strategy use → performance).
- **A Debugging Concept Inventory (DCI)** (measurement lessons 12–18): built across the
  block — construct definition → items written from the qualitative module's interview
  findings (misconception-driven item writing, exactly how the BDSI and VT's recursion
  inventory were built) → pilot → item analysis → reliability → validity argument → IRT
  calibration → DIF check.

Where the throughline is deliberately **not** used: the inference-logic lesson, the
validity-frameworks lesson, and the instruments lesson teach best through the real
published examples (the SCS1 arc) — forcing debugging into those would contort them.

Note for later (mixed-methods module): interviews → items → quantitative validation is
a textbook exploratory-sequential design; the modules then form one continuous study arc.

**Datasets:** ship the running example as downloadable synthetic CSVs in
`public/templates/` — `debugging-study.csv` (long format: student, section, exercise,
fixed, time-to-fix, pre/post, self-efficacy items — long format so the GEE/multilevel
lesson needs no reshaping) and `dci-pilot.csv` (item-level responses) — generated by a
script in `scripts/` (precedent: the PM planning-sheet generator). Every code snippet
in the module then runs against real files. Synthetic data needs no IRB; if real pilot
data ever exists, swap the CSVs.

---

## Example scripts (R and Python)

Every analysis lesson carries short, copy-paste-runnable snippets against the shipped
CSVs — snippets, not tutorials (link Masur's IRT-in-R walkthrough and the CRAN
Psychometrics task view for depth). Language policy: **both R and Python where both are
first-class; R alone where the Python ecosystem is weak** (psychometrics and SEM are
R's home turf — name the Python option so readers know it exists, don't teach it).

| Lessons | Languages | Packages |
|---|---|---|
| 5–10 (tests, ANOVA, regression, logistic, GLMs, MLM/GEE) | R + Python | R: base, `car`, `effectsize`, `marginaleffects`, `lme4`, `geepack` · Py: `pandas`, `scipy.stats`, `pingouin`, `statsmodels` (incl. `Logit.get_margeff`, `mixedlm`, `GEE`) |
| 4 (effect sizes) | R + Python | `effectsize` · `pingouin` |
| 11 (SEM) | R (Python mentioned) | `lavaan` (mention `semopy`) |
| 13, 15, 16 (reliability, item analysis, IRT) | R (Python mentioned) | `psych`, `mirt` (mention `girth`/`py-irt` as immature) |
| 17 (DIF) | R | `difR` |
| 1–3, 12, 14, 18 | none / trivial | conceptual lessons |

jMetrik (free GUI) is named in lesson 13 as the no-code on-ramp for undergrads not yet
in R.

**New component: `CodeTabs`** — a small tabbed R/Python code block (two `<pre>` panels,
same toggle pattern as MeasureExplorer). Plain stacked code blocks work day one; the
component is polish, not a blocker.

---

## Interactive question walkthroughs (`ScenarioWalkthrough`)

Scenario-based trainers for "which analysis do I pick and why." The evidence base is
direct: an RCT (Allen et al. 2019, N=217) found an interactive one-question-at-a-time
decision aid beat both a textbook and a paper flowchart on selection accuracy with
lower cognitive load, and the qualitative work behind it (Allen, Dorozenko & Roberts
2016) shows students select tests by surface keywords because the expert decision
process is never externalized. That process — outcome type → unit of
independence/pairing/nesting → analysis → assumptions/reporting — is exactly what each
walkthrough steps through.

**How it differs from DecisionTree:** a walkthrough fixes the facts in a vignette, so
it runs on a *linear step spine* with a forced choice at each step. Wrong picks never
derail the route — they open feedback, then everyone continues. Each option carries a
three-valued verdict (**best / defensible / trap**) with 2–4 sentences of feedback
naming the structural cue it honors or ignores; traps additionally carry a
*"this would be the right call if…"* line (every trap maps to a documented
misconception — ignored pairing, ignored nesting, the normality-test ritual, OR read
as "times more likely," "IRT = validated"). Feedback is hidden until the reader
commits; after the first pick the other options become inspectable for comparison.
The final card gives a recommendation, a ready-to-adapt **reporting sentence** with
bracketed placeholders, caveats, "why not X?" disclosures, and deep links into
lessons. No scoring, no persistence — house rules. Degrades without JS into a
readable worked decision (all panels unhidden via `<noscript>` styles).

New files: `src/components/wiki/ScenarioWalkthrough.astro` +
`src/data/quant-scenarios.ts` (typed, JSDoc-ed authoring rules — one `best` per step,
traps require `whenRight`, step 1 never offers test names). Reuses RoleWalkthrough's
hidden-card stage/progress, DecisionTree's option buttons and tone palette, Reveal's
disclosure markup, and `getReference()` for citations on the verdict card.

**Three walkthroughs are fully authored** (complete option-by-option feedback text in
the appendix, ready to transcribe into `quant-scenarios.ts`):

| Walkthrough | Host lesson | Premise |
|---|---|---|
| WT1 `sections-prepost` | 6 anova-and-categorical | Two intact sections, pre/post debugging test — paired vs independent vs gain scores vs ANCOVA; verdict teaches Lord's paradox and "two sections = a limitation, not a random effect" |
| WT2 `attempts-gee` | 10 clustered-data-mlm-gee | 462 fixed/not-fixed attempts from 40 students — unit of independence, logistic vs GEE vs mixed logistic, and which plain-English sentence matches which estimand |
| WT3 `dci-irt` | 15 irt-fundamentals | N=150 pilot, "run IRT on the DCI" — CTT screening first, Rasch (not 2PL/3PL) at this N, DIF deferred with subgroup arithmetic shown |

Planned later: WT4 (reliability lesson: which coefficient — alpha/omega vs ICC vs
kappa across three lab artifacts) and WT5 (instruments lesson: capstone critique of a
flawed pilot write-up — erroneous-example format, deliberately last, per Große &
Renkl 2007). Other placements are deliberate callbacks, not new widgets: lesson 7
reopens WT1's verdict ("the ANCOVA you picked is this lesson's
`lm(post ~ pre + section)`"), lesson 8 forward-links WT2, lesson 17 opens by
replaying WT3's DIF step.

**The overview's which-test DecisionTree stays, demoted from teacher to map**:
retitled "Quick test finder" (for when you already understand your design), with two
cheap patches for its worst flowchart blind spots — a first-question option for
"repeated/clustered observations" routing to lesson 10, and "my question is about the
instrument itself" routing to the measurement block. Per-option feedback is *not*
bolted onto DecisionTree — the two contracts (route your own study vs train on a
fixed vignette) stay separate components.

---

## GenAI toolbox (`GenAiToolbox`)

A recurring aside teaching RAs to use LLMs according to best practice — an aside, not
the lesson's main widget, so it doesn't compete with one-widget-per-big-idea. Two
small components plus one data file, all server-rendered:

- `src/components/wiki/GenAiToolbox.astro` — a distinctive Callout sibling
  (violet accent). Data-driven from `src/data/genai-toolbox.ts`: per-entry
  `task`, `tool` tier note, example `prompt` in a `<details>` block (+ copy button),
  `promptNotes`, a **"verify before trusting" checklist** (decorative boxes — no
  state), and a cited **known failure mode** strip. Footer links to the ground rules.
- `src/components/wiki/GenAiGroundRules.astro` — rendered once in the overview under
  `#genai-ground-rules`; every toolbox links back to it.

**Ground rules** (10 rules, each traceable to a source; full text in appendix):
never paste participant data into public AI tools (VT SIRC guidance; pasting is
third-party disclosure); "I deleted the names" ≠ de-identified (FERPA/PTAC —
indirect identifiers, small cells, code style); never cite what you haven't retrieved
(measured fabrication rates 18–55% — Walters & Wilder 2023, Chelli et al. 2024);
model confidence ≠ evidence (~88% stated confidence at ~79% accuracy — Chhikara
2025); never upload others' work you're reviewing (ACM/NSF/NIH prohibitions); use the
VT-approved tool tier (Copilot with VT sign-in) for anything near study data; prompt
with the schema, never the data, and ask for assumptions/diagnostics (prompt
specificity moved inferential accuracy 32.5%→92.5% in one validation — Ruta et al.
2025); **the code is the artifact of record** — every reported number regenerates
from a script you ran (half of LLM programming answers contained errors; readers
missed them 39% of the time — Kabir et al. 2024); keep a 4-line AI-use log (date,
tool+model, use, verification); disclose per venue (ACM Acknowledgements, APA
Method) — AI is never an author, and undisclosed use is being actively detected
(Glynn, Academ-AI).

**Placement map** (12 toolboxes; skips are deliberate and stated — concept lessons
where outsourcing defeats the point get none):

| Lesson | Entry | Task |
|---|---|---|
| 1 overview | `GenAiGroundRules` box | the rules, once |
| 2 descriptive-stats | `desc-code` | draft summary/plot code from the CSV *schema*; rerun everything |
| 4 effect-sizes-and-reporting | `disclosure-draft` | draft the venue-specific disclosure statement from your AI-use log; hallucinated-references warning for lit search |
| 5 comparing-two-groups | `ttest-assumptions` | schema prompt that must include assumption checks + effect size (the Ruta specificity pattern) |
| 6 anova-and-categorical | pointer Callout | "reuse lesson 5's prompt pattern; swap the model" |
| 7 linear-regression | `lm-whats-wrong` | paste model formula + design (not data); ask "what could be wrong?" |
| 8 logistic-regression | `logistic-translate` | plain-language translation of YOUR verified output — **fully worked in appendix** |
| 9 glms-beyond-binary | `glm-errors` (light) | paste the convergence warning, never the data |
| 10 clustered-data-mlm-gee | `mlm-syntax` | lme4/geepack syntax scaffolding from a design description; ask for options + tradeoffs, not one answer |
| 11 sem | `sem-lavaan` | lavaan syntax from your drawn path model; require df/parameter count in comments for hand-checked identification |
| 13 reliability-and-item-analysis | `alpha-omega` | psych alpha+omega code; cross-check two packages |
| 15/16 irt | `mirt-calibration` (in 16) | draft the mirt calibration script — **fully worked in appendix** (schema-only prompt, pinned package version, cutoffs-with-sources, verify by rerun + eRm cross-check) |
| 17 dif-and-fairness | `dif-code` + Reveal exercise | difR code; live exercise: ask an LLM for 5 DIF references, then try to retrieve each — makes the fabrication rule visceral |
| 18 instruments-in-practice | `item-drafting` + warning Callout | LLM-assisted item drafting with mandatory expert review + cognitive interviews (Küchemann et al. 2024: near-human quality, not equal) |

No toolbox in 3, 12, 14 (concept/judgment lessons — a stated rationale, e.g.
validity argumentation is human judgment and fluent overclaiming bites hardest there).

**The contamination warning (lesson 18, its own warning Callout, not a toolbox):**
GPT-4-class models solve CS1 exams and concept inventories above post-instruction
undergrads (Finnie-Ansley et al. 2022, 2023; Savelka et al. 2023; Kortemeyer et al.
2025). Any unproctored DCI administration can no longer separate student ability from
AI assistance, and pre/post gains can be contaminated — a threat to the instrument's
*validity argument*, not just to one analysis. Cross-links: MacNeil et al. 2024
("Imagining Computing Education Assessment after Generative AI") and the ITiCSE
working-group reports (Prather et al. 2023, 2024, 2025).

---

## Lesson plan

### Ungrouped openers

| # | Lesson (slug) | Est | Content | Widget / scripts |
|---|---|---|---|---|
| 1 | `overview` (revise) | 6 | What quant analysis is; introduce the debugging-intervention running example + the two CSVs; workflow; keep the which-test DecisionTree, extend its result nodes to link to lessons below | DecisionTree (exists) |
| 2 | `descriptive-stats` (revise lightly) | 7 | As-is; swap in running-example data — time-to-fix is naturally right-skewed, which motivates the existing mean-vs-median plot | DistributionPlot (exists) |

### Group: Inference

| # | Lesson | Est | Content | Widget / scripts |
|---|---|---|---|---|
| 3 | `inference-basics` | 12 | Population vs sample; sampling variability, SE, confidence intervals; NHST logic, what p is and is not; Type I/II, power; convenience sampling and claims (Randolph: 86% of CER samples); "medium-n" underpowered class-sized studies (Guerzhoy 2023) | Reveal misconception quiz; optional sampling-simulator widget |
| 4 | `effect-sizes-and-reporting` | 12 | Cohen's d, r, eta², odds ratios; CIs on effects; "significant ≠ important"; documented under-reporting at ICER (Sanders 2019); reporting norms (statistic, df, p, effect size, CI); plain-language reporting as a norm (sets up lesson 8); the CER pitfalls checklist (anecdotal evidence, no comparison group, forking paths, multiple comparisons — Randolph 2008, Sanders et al. 2019, Sanders/Vahrenhold/McCartney 2023) | new: effect-size explorer (two distributions, drag d, overlap/CLES readout); R+Py |

### Group: Comparing groups

| # | Lesson | Est | Content | Widget / scripts |
|---|---|---|---|---|
| 5 | `comparing-two-groups` | 10 | Independent/paired t-tests, assumptions, Mann-Whitney/Wilcoxon (with chi-square, the CER "big three" — Sanders 2019); intervention vs comparison section | R+Py |
| 6 | `anova-and-categorical` | 13 | One-way ANOVA, factorial + interactions, post-hoc + multiple-comparisons correction, Kruskal-Wallis, ANCOVA for pretest control; chi-squared, Fisher's exact for small classes (fixed/didn't-fix) | R+Py |

### Group: Regression & modeling

| # | Lesson | Est | Content | Widget / scripts |
|---|---|---|---|---|
| 7 | `linear-regression` | 12 | Simple/multiple regression; assumptions and diagnostics (residual plots); interactions; standardized coefficients; R² vs adjusted; explanation vs prediction (ridge/lasso get a one-callout mention, not a lesson) | R+Py |
| 8 | `logistic-regression` | 13 | The CER retention/pass-fail workhorse. Logit link; coefficients live in log-odds — **and nobody thinks in log-odds, so the lesson is built around translation**: (a) odds ratios, *with their traps* — OR ≠ risk ratio, "3× the odds" gets read as "3× as likely" and overstates the effect when the outcome is common (Norton et al. 2018); (b) **predicted probabilities** at representative values — the honest default for any audience; (c) **average marginal effects** — "the intervention raised the chance of fixing the bug by 14 percentage points" is the sentence an instructor can use; (d) probability-curve plots over a continuous predictor; (e) the divide-by-4 shortcut for a quick ceiling (Gelman & Hill). Reporting recipe: coefficient table with OR + CI for the paper, AME + pp sentence for humans. Multinomial gets a mention | new: **logit translator** widget (baseline-probability + OR sliders → new probability and pp change — shows the same OR meaning different pp at different baselines); R (`glm` + `marginaleffects`) + Py (`statsmodels Logit` + `get_margeff`) |
| 9 | `glms-beyond-binary` | 10 | The GLM family portrait (link functions); **ordinal/proportional-odds** for Likert outcomes — the honest alternative to means-on-ordinal (Kaptein et al.: 45% of CHI papers had Likert data, 8% analyzed it appropriately); **counts**: Poisson → negative binomial (bugs-found counts, overdispersion); interpreting each on its natural scale (predicted category probabilities, rate ratios) — same translation discipline as lesson 8 | R+Py |
| 10 | `clustered-data-mlm-gee` | 13 | Students within sections, exercises within students — observations aren't independent (pseudoreplication). Two fixes with different meanings: **mixed-effects models** (random intercepts/slopes; conditional, subject-specific estimates) vs **GEE** (population-averaged estimates with robust/sandwich SEs; working correlation structures in one paragraph). When each answers your question — and the punchline that for *logistic* outcomes the two genuinely differ: marginal ORs are attenuated relative to conditional ones, so which one you report changes the number (cross-link lesson 8). Running-example fit: GEE-logistic on fixed/not-fixed across repeated exercises per student. Honesty beats: GEE wants ~30+ clusters — two sections is a fixed effect, not a random one; intraclass correlation as "how much nesting matters" | R (`lme4`, `geepack`) + Py (`statsmodels mixedlm`, `GEE` — statsmodels' GEE support is solid) |
| 11 | `sem` | 14 | Path analysis and mediation (indirect effects, bootstrap CIs — instruction → strategy use → performance); **CFA** as the measurement model (loadings, omega — bridge to lesson 13); full structural models; fit indices (χ², CFI/TLI, RMSEA, SRMR) and their abuse; measurement invariance in brief (multi-group CFA — the SEM cousin of DIF, cross-link lesson 17); sample-size reality: SEM wants hundreds | R (`lavaan`); path-diagram figure |

### Group: Measurement & IRT (the heavy block)

Sequenced per the consensus of psychometrics syllabi and the Bandalos/de Ayala chapter
order: CTT first (IRT is motivated as the fix for CTT's limits), applications last.

| # | Lesson | Est | Content | Widget / scripts |
|---|---|---|---|---|
| 12 | `measurement-foundations` | 10 | Constructs and latent variables; scores as inferences; construct underrepresentation vs construct-irrelevant variance; levels of measurement; the true-score model X = T + E and what it assumes; SEM (of measurement) is constant in CTT — contrast planted for IRT; the "validated instrument" fallacy; introduce the DCI and the real gap it mirrors | ProcessFlow (instrument pipeline) |
| 13 | `reliability-and-item-analysis` | 14 | Test-retest, alternate forms, internal consistency; alpha — assumptions and misuse; omega as modern default (Sijtsma 2009; McNeish 2018); Spearman-Brown and test length; score confidence bands; misconceptions: high alpha ≠ unidimensional, reliable ≠ valid, alpha-chasing. Then classical item analysis on the DCI pilot: difficulty p (it measures *easiness*), discrimination, corrected item-total point-biserial, distractor analysis — find the two bad items | new: item-analysis table (sortable stats + flag-the-item Reveal); R (`psych`); jMetrik named |
| 14 | `validity` | 12 | Content/criterion/construct trinity → Messick's unified view → the Standards' (AERA/APA/NCME 2014) five sources of evidence → Kane's argument-based approach; Reeves & Marbach-Ad (2016) as the assigned reading (free, written for DBER); worked validity argument for the DCI | SideBySide (trinity vs five sources) |
| 15 | `irt-fundamentals` | 13 | CTT's limits (sample-dependent item stats, test-dependent scores, one SEM for everyone); the item characteristic curve; theta and its arbitrary scale (not percent-correct); Rasch/1PL, 2PL, 3PL (lower asymptote ≠ 1/k); the Rasch-vs-IRT philosophical divide; sample-size guidance: Rasch ~100–250, 2PL ~500, 3PL 1000+ → *for course-sized data, Rasch or CTT*. Terminology callout: ICC here = item characteristic curve, not the intraclass correlation from lesson 10 and the IRR lesson | **new: ICC explorer** (a/b/c sliders → live curve; 1PL/2PL/3PL presets) — the module's flagship widget, KappaCalculator-class; R (`mirt`) |
| 16 | `irt-in-practice` | 14 | Item/test information; conditional SEM = 1/√information (a test is only precise where its information is); scoring (ML vs EAP/MAP, one line each); assumptions: unidimensionality, local independence (shared code-stem testlets are the CER-native violation), monotonicity; fit at a glance; polytomous models: GRM for Likert scales (the debugging self-efficacy scale), Partial Credit for rubrics; callout: equating/CAT exist — pre/post with overlapping items is secretly an equating problem (Kolen & Brennan pointer) | new: test-information builder (toggle items, watch TIF + SEM band) — or fold into ICC explorer v2; R (`mirt`) |
| 17 | `dif-and-fairness` | 12 | Impact ≠ DIF ≠ bias (the three-way confusion, spelled out); uniform vs non-uniform DIF; Mantel-Haenszel, logistic-regression, IRT-based tests; purification; real cases: gender DIF in an SCS1-derived exam (Davidson et al. 2021), distractor-level bias (Parker et al. 2026), fairness-first design (cCTt); cross-link to measurement invariance (lesson 11) | new: two-group ICC overlay (reuses ICC-explorer internals); R (`difR`) |
| 18 | `instruments-in-practice` | 14 | Using existing instruments: the CS-ed landscape (SCS1/FCS1, BDSI, VT's recursion inventory, CCI, CAS, self-efficacy & belonging scales; csedresearch.org as the index); **the SCS1 arc as cautionary centerpiece** — built 2016 → IRT re-analysis finds 3 off-construct + 4 too-hard items (Xie et al. 2019) → gender DIF 2021 → distractor bias 2026 → a decade of ad-hoc shortening/translation invalidating the evidence (Parker, Guzdial & Tew 2021; Vieira et al. 2024); rule: adaptation requires re-validation. Building your own: when *not* to (search first); DeVellis/Boateng pipeline — construct → items from qualitative findings (link to qualitative module) → expert review → think-alouds → pilot → EFA/CFA in brief (parallel analysis over eigenvalue>1; EFA and CFA on separate samples) → the DCI story closes | instrument browser (MeasureExplorer generalized to take data via props) or a plain table |

### Closer

| # | Lesson | Est | Content |
|---|---|---|---|
| 19 | `references` | 6 | Tagged bibliography (`ReferenceList`) |

Deliberately out of scope (one sentence + pointer each, in the overview so omissions
are visible): Bayesian methods, learning analytics/EDM and knowledge tracing
(Ihantola et al. 2015 pointer), meta-analysis, survival analysis, equating/CAT beyond
the lesson-16 callout, multidimensional IRT, generalizability theory.

---

## New interactive components (build only as lessons need them)

1. **ScenarioWalkthrough** (lessons 6, 10, 15; later 13, 18) — the question-walkthrough
   widget; three walkthroughs' content is already authored (appendix). With its data
   file this is now the highest-priority build alongside the ICC explorer.
2. **ICC explorer** (lessons 15–17) — sliders for discrimination/difficulty/asymptote →
   live logistic curve; model presets; later a threshold-curve mode (polytomous) and a
   two-group overlay (DIF). One widget family, three lessons.
3. **GenAiToolbox + GenAiGroundRules** (12 lessons + overview) — server-rendered
   asides driven by `genai-toolbox.ts`; two entries fully worked (appendix).
4. **CodeTabs** (most analysis lessons) — tabbed R/Python code panels; MeasureExplorer's
   toggle pattern. Stacked code blocks are the day-one fallback.
5. **Logit translator** (lesson 8) — baseline-probability + odds-ratio sliders → new
   probability and percentage-point change. Small widget, carries the lesson's central
   point (the same OR means different pp changes at different baselines).
6. **Item-analysis table** (lesson 13) — DCI pilot data, computed p/point-biserial,
   sortable, find-the-bad-item Reveal.
7. **Effect-size explorer** (lesson 4) — two distributions, drag d, overlap/CLES.
8. **Test-information builder** (lesson 16) — possibly ICC-explorer v2 rather than new.
9. Sampling simulator (lesson 3) — optional; the lesson works without it.

Plus the two **synthetic CSVs + generator script** (`scripts/`, output to
`public/templates/` — PM-module precedent).

Reused as-is: DecisionTree, Reveal, Callout, Steps, SideBySide, ProcessFlow,
DistributionPlot, SheetEmbed, ReferenceList, Cite.

---

## References to add to `references.json`

The full harvest is in the appendix (125 citations across four research sweeps, with
per-citation notes and URLs). Sixteen high-priority citations were independently
verified (authors/venue/year/URL confirmed) — those can enter `references.json` with
`verified: true` immediately; the rest go through the usual check when their lesson is
written. The curated core, by tag:

Tag `quant` (stats lessons): Sanders et al. 2019 (ICER inferential-stats review);
Randolph et al. 2008; Cambridge Handbook chs. 5–6 (Haden); Guerzhoy 2023 (medium-n);
Robertson 2012 (CACM); Kaptein, Nass & Markopoulos 2010; Sanders, Vahrenhold &
McCartney 2023 (threats/limitations); Heckman et al. 2022 (TOCE reporting SLR);
Ihantola et al. 2015 (EDM); Porter, Bailey Lee & Simon 2013 (exemplar
quasi-experiment); Michaeli & Romeike 2019; DEERS (empiricalcsed.org) as a linked
resource. **New from the sweep** — ✓ = verified: ✓ Gelman, Hill & Vehtari 2020
*Regression and Other Stories* (free PDF; replaces the Gelman & Hill 2007
recommendation as the spine for lessons 7–10, divide-by-4 included); ✓ Lakens 2013
(effect-size primer, free); ✓ Appelbaum et al. 2018 (APA JARS-Quant reporting
standards); Wasserstein, Schirm & Lazar 2019 ("Moving to a World Beyond p<0.05",
free); Norton, Dowd & Maciejewski 2018 (JAMA odds-ratio piece) + Norton & Dowd 2018
(free HSR companion); ✓ Mize 2019 (nonlinear interactions, free); ✓ Arel-Bundock,
Greifer & Heiss 2024 (marginaleffects, JSS, free); ✓ McNeish, Stapleton & Silverman
2017 ("Unnecessary Ubiquity of HLM" — the MLM-vs-GEE-vs-cluster-robust decision
paper, lesson 10's backbone); ✓ Theobald 2018 (random effects for DBER, free — the
audience-matched MLM reading); Hubbard et al. 2010 ("To GEE or Not to GEE");
McNeish & Stapleton 2016 (few-clusters guidance); Sommet & Morselli 2017 (multilevel
logistic walkthrough, free); Kline 2023 (SEM 5th ed.); ✓ Rosseel 2012 (lavaan, JSS,
free); Hu & Bentler 1999 + Marsh, Hau & Wen 2004 (fit cutoffs and their critique —
teach both); Hoekstra, Kiers & Johnson 2012 (assumption-checking rituals, free).
Walkthrough-specific: Lord 1967 (Lord's paradox); Van Breukelen 2006 (ANCOVA vs
change scores); Mancl & DeRouen 2001 (small-sample GEE correction).

Tag `measurement` (lessons 12–18): AERA/APA/NCME Standards 2014; Messick 1995; Kane
2013; Reeves & Marbach-Ad 2016 (free, PMC); Sijtsma 2009; McNeish 2018; Boateng et al.
2018 (free); DeVellis & Thorpe (5th ed.); Bandalos 2018; de Ayala 2022; Embretson &
Reise 2000; Baker 2001 (*free PDF* — the gentle IRT on-ramp, link it); Chalmers 2012
(mirt, JSS, free); Tew & Guzdial 2011 (FCS1); Parker, Guzdial & Engleman 2016 (SCS1);
Xie, Davidson, Li & Ko 2019 (SCS1 IRT); Davidson et al. 2021 (DIF); Parker, Guzdial &
Tew 2021 (reuse); Vieira et al. 2024 (translation); Porter et al. 2019 (BDSI); Hamouda,
Edwards et al. 2017 (recursion CI — VT); Tew & Dorn 2012 / Dorn & Tew 2015 (CAS);
Ramalingam & Wiedenbeck 1998 + Tsai et al. 2019 (self-efficacy); Yang et al. 2024
(debugging-interventions SLR); Decker & McGill 2019 + csedresearch.org. **New from
the sweep**: ✓ Wilson 2023 (*Constructing Measures* 2nd ed. — construct maps, the
instrument-development spine alongside Boateng); ✓ Adams & Wieman 2011 (DBER
instrument development); ✓ Willis & Artino 2013 (cognitive interviewing primer,
free); Boone 2016 (Rasch for instrument development, CBE-LSE, free) + Planinic et al.
2019 (Rasch in PER, free — the Rasch-in-DBER pair for lesson 15); ✓ Bloch & Norman
2012 (G-theory for the perplexed — the one G-theory pointer); Linacre 1994 (Rasch
sample sizes). **GenAI-era assessment validity** (lesson 18): Finnie-Ansley et al.
2022 + 2023 (Codex on CS1/CS2 exams, free); Savelka et al. 2023 (GPT-4 on
higher-ed assessments, free); Kortemeyer et al. 2025 (concept inventories, free);
Küchemann et al. 2024 (ChatGPT-generated CI items, free); MacNeil et al. 2024
(assessment after GenAI); Prather et al. 2023/2024/2025 (ITiCSE WG reports, free);
Pangakis et al. 2023 (automated annotation requires validation).

Tag `genai` (toolbox + ground rules): ACM authorship policy FAQ 2023; APA journals
GenAI policy + McAdoo 2023 (how to cite); ICMJE; Science/Nature policies; NSF 2023 +
NIH NOT-OD-23-149 (review confidentiality); **VT SIRC "Using AI During Research
Activities"** + **VT DoIT 2025 data notice** (the lab's own institution); PTAC
de-identification overview (FERPA); Walters & Wilder 2023 + Chelli et al. 2024
(fabricated citations); Kabir et al. 2024 (ChatGPT code errors, CHI); Ruta et al.
2025 (prompt specificity validation, JMIR); Chhikara 2025 (overconfidence); Dobler
et al. 2025 (biostatistician tutorial); Smith et al. 2024 (Ten Simple Rules, PLOS
CB); TRIPOD-LLM 2025 (reporting guideline); Perkel 2023 (coding with ChatGPT,
Nature); Glynn 2024 (Academ-AI, undisclosed-use detection).

Walkthrough-design sources (cite in the component's data-file JSDoc and the plan, not
necessarily in lessons): ✓ Allen et al. 2019 (StatHand RCT); ✓ Allen, Dorozenko &
Roberts 2016 (how students actually pick tests); ✓ Quilici & Mayer 1996 (surface vs
structure in stats problems); ✓ Castro Sotos et al. 2007 (inference misconceptions —
the trap catalog); ✓ Renkl & Atkinson 2003 (fading); ✓ Shute 2008 (elaborated
feedback); ✓ GAISE College Report 2016 (free); Große & Renkl 2007 (erroneous
examples); Lindeløv 2019 ("common tests are linear models", free — the unity move
lesson 7 makes).

---

## Suggested build order

1. **Foundations** — revise 1–2 (overview gains the ground-rules box and the demoted
   "Quick test finder"), write 3–6; generate the CSVs; CodeTabs (or stacked blocks);
   **ScenarioWalkthrough component + WT1** (its content is pre-authored). Module loses
   `underConstruction`.
2. **Regression & modeling** (7–11) + logit translator + WT2 + the GenAI toolbox
   component with its first entries (`logistic-translate` is pre-authored).
3. **Measurement CTT** (12–14) + item-analysis table.
4. **IRT + DIF** (15–17) + ICC explorer + WT3 + `mirt-calibration` (pre-authored).
5. **Instruments capstone** (18) incl. the contamination warning. References land
   block-by-block.

Each phase is independently shippable.

## Open questions

- Synthetic vs real DCI pilot data (synthetic is safe and shipped; the debugging-
  assessment gap is also a genuine research opening for the lab beyond the wiki).
  Note the appendix worked example assumes N=212 for the pilot CSV while WT3's
  vignette says N=150 — pick one N when generating `dci-pilot.csv` and align both.
- CodeTabs component vs plain stacked R/Python blocks (start stacked, promote later).
- Whether lesson 16's information builder is its own widget or ICC-explorer v2.
- Whether the GenAI ground rules live only in this module's overview or get promoted
  to a wiki-wide page later (they apply to the qualitative module too — e.g., LLM
  coding of transcripts); start module-local, promote if referenced from elsewhere.
