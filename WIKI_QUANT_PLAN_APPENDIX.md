# Appendix: full research + design output for WIKI_QUANT_MEASUREMENT_PLAN.md

Companion to `WIKI_QUANT_MEASUREMENT_PLAN.md` (2026-07-17). Contains the full-text
authored walkthroughs, the GenAI toolbox spec with complete worked prompts, and the
complete literature harvest (125 citations across four sweeps; the 16 marked ✓ were
independently verified — details in the verification table at the end). Lesson numbers
inside the two specs below use the *designers'* assumed numbering; the plan's
"Interactive question walkthroughs" and "GenAI toolbox" sections hold the
authoritative remapped placements.

---

# Part 1 — ScenarioWalkthrough spec + three authored walkthroughs

# ScenarioWalkthrough — spec for interactive "which analysis and why" walkthroughs (quantitative module)

Planning spec. Grounded in the existing components at `/home/anavarre/Projects/ascend_website/src/components/wiki/` (DecisionTree.astro, RoleWalkthrough.astro, Reveal.astro, Callout.astro, Cite.astro), the data-props convention of `/home/anavarre/Projects/ascend_website/src/data/qual-roles.ts`, and the existing which-test DecisionTree in `/home/anavarre/Projects/ascend_website/src/content/wiki/quantitative/overview.mdx` (lines 32–65).

---

## 0. Design rationale (why this shape, in one screen)

- **Vignette supplies the facts; the reader's job is to read the design.** DecisionTree asks the reader about *their own* study, so it must branch. A teaching walkthrough fixes the facts in a vignette, so the correct route is determined and the component can be a **linear step spine** (RoleWalkthrough's machinery) with a **forced choice at each step** (DecisionTree's option buttons). Wrong picks never derail the route — they open feedback, then everyone continues on the same spine. This is what lets every option teach.
- **Steps are design questions, never test names first** (StatHand; Hand 1994; Allen 2016): outcome type → unit of independence/pairing/nesting → analysis → assumptions/reporting.
- **Every option's feedback = Shute's elaborated feedback, enforced by schema**: a `feedback` field that must name the structural cue, plus a `whenRight` field ("this would be the right call if…") required on traps — the boundary-condition move that turns a wrong answer into a schema edge.
- **Traps instantiate documented error patterns** (Castro Sotos 2007; Hoekstra 2012; CAOS distractor tradition): ignored pairing, ignored nesting, normality-test ritual, OR misread as "times more likely", "IRT = validated", significant-within-group-change-in-treatment-arm.
- **Non-unique answers are first-class**: a three-valued verdict (`best` / `defensible` / `trap`) so "both are defensible, here's the tradeoff" (GraphPad's honest tone) and non-test endpoints ("this is a measurement question") are expressible.
- **Commit before feedback**: feedback is hidden until the reader picks — that commitment is the pedagogical difference from `Reveal`. After the first pick, all other options become inspectable so readers can compare boundaries (Quilici & Mayer structure-contrast).
- **No scoring, no persistence, no localStorage.** House rule: plain reference wiki, no progress/gamification. Picks live in in-memory JS state only and reset on reload.

---

## 1. (a) Component spec

### Files

- Component: `/home/anavarre/Projects/ascend_website/src/components/wiki/ScenarioWalkthrough.astro`
- Data: `/home/anavarre/Projects/ascend_website/src/data/quant-scenarios.ts` (named exports, one `Scenario` per walkthrough; JSDoc header explaining authoring rules, mirroring qual-roles.ts style)
- Styles: new `.wiki-scn*` block in `/home/anavarre/Projects/ascend_website/src/styles/wiki.css`, reusing the existing tone palette (`.wiki-tree__badge--good/warn/alert` colors and the `--color-primary/secondary/accent/danger` variables already used by DecisionTree results)
- Usage in MDX:
  ```mdx
  import ScenarioWalkthrough from '@wiki/ScenarioWalkthrough.astro';
  import { sectionsPrepost } from '../../../data/quant-scenarios';

  <ScenarioWalkthrough data={sectionsPrepost} />
  ```

### Data shape (TypeScript-ish)

```ts
export type Verdict = 'best' | 'defensible' | 'trap';
// rendered badge labels: best → "Right read", defensible → "Defensible", trap → "Trap"
// tone mapping: best → good (green), defensible → warn (amber), trap → alert (red)

export interface ScenarioOption {
  /** Button text. On early steps this is a claim about the design, never a bare test name. */
  label: string;
  verdict: Verdict;
  /**
   * 2–4 sentences. MUST name the structural cue this option honors or ignores,
   * and why that earns the verdict. Never a bare "correct/incorrect".
   */
  feedback: string;
  /** "This would be the right call if…" — REQUIRED when verdict === 'trap', optional otherwise. */
  whenRight?: string;
}

export interface ScenarioStep {
  id: string;                 // stable anchor, e.g. 'unit', 'family', 'report'
  question: string;           // the design question, phrased the way an expert would ask it
  options: ScenarioOption[];  // 3–4; EXACTLY ONE 'best'; zero or more 'defensible'
  note?: string;              // optional one-liner shown once the step is resolved (transition / expert aside)
}

export interface Scenario {
  id: string;                 // e.g. 'sections-prepost'
  title: string;              // card header, e.g. "Two sections, pre and post"
  vignette: string;           // 60–120 words; complete design info: who, N, assignment, measures, timing, the actual question
  facts: string[];            // 3–6 short chips ("N = 58 + 61", "self-selected sections", "same test twice") pinned above every step
  steps: ScenarioStep[];      // 3–5 steps
  verdict: {
    recommendation: string;                    // the analysis + spec, one short paragraph
    reportingSentence: string;                 // ready-to-adapt sentence(s); [bracketed] placeholders for numbers
    caveats: string[];                         // 3–6, each one sentence
    alternatives?: { label: string; body: string }[]; // "Why not X?" — rendered as native <details> in Reveal's markup/classes
    lessons: { label: string; href: string }[];       // deep links into module lessons
    citeIds?: string[];                        // resolved server-side via getReference() and rendered as Cite-style links
  };
}
```

All strings are plain text (no embedded markup), matching DecisionTree/RoleWalkthrough. Citations that need to sit *inside* prose belong in the surrounding lesson MDX, not in widget strings; the verdict card's `citeIds` covers the widget's own sourcing.

### Interaction flow

1. **Vignette card** (server-rendered, always visible): title, vignette paragraph, fact chips, "Start" button. Fact chips stay pinned above the stage on every step — they are the "definitions/examples embedded at the decision point" that made StatHand beat paper trees.
2. **Step card** (one visible at a time, all server-rendered with `hidden`, RoleWalkthrough pattern): question + option buttons (DecisionTree's `.wiki-tree__option` styling). Below the options, one feedback panel per option, server-rendered and hidden.
3. **Pick an option** → button gets `aria-pressed="true"` and a "your pick" tag; its feedback panel unhides showing the verdict badge + feedback + whenRight line; focus moves to the panel (panel heading has `tabindex="-1"`). The stage is `aria-live="polite"` (DecisionTree pattern).
4. **After the first pick**, the other option buttons remain clickable, restyled as "compare" — clicking unhides their panels too (panels accumulate in option order; the first pick keeps its tag). A "Continue" button appears only after the first pick: commitment before feedback, exploration after.
5. **Continue** advances the spine (`Question 2 of 4` progress + prev/next, straight from RoleWalkthrough). "Prev" is allowed; resolved steps keep their opened panels (in-memory state only).
6. **After the last step** → **verdict card**: recommendation paragraph, reporting sentence in a bordered monospace block ("adapt the brackets, keep the shape"), caveat list, `alternatives` as `<details class="wiki-reveal">` items ("Why not repeated-measures ANOVA?"), lesson links, citations.
7. **"↺ Start over"** resets picks and returns to the vignette (DecisionTree's restart).

No branching, no scoring, no localStorage, no completion state.

### Accessibility

- Everything server-rendered; JS only toggles `hidden` — same progressive pattern as RoleWalkthrough.
- Verdicts conveyed by text badge ("Right read" / "Defensible" / "Trap"), never color alone.
- `aria-pressed` on option buttons; feedback region gets `role="group"` with a label naming the option it belongs to; focus management to the revealed panel so screen-reader users hear feedback immediately after activating.
- Prev/next buttons use real `disabled` at the ends (RoleWalkthrough behavior).
- **No-JS upgrade over house baseline**: a `<noscript><style>` block scoped to `.wiki-scn` unhides all steps and all feedback panels, so without JS the widget degrades into a *readable worked decision* (question, all options with inline verdict labels, all feedback, verdict card) instead of RoleWalkthrough's "enable JavaScript" apology.

### Reuse map

| Piece | Taken from |
| --- | --- |
| Hidden-card stage, prev/next, "Step x of y" progress | RoleWalkthrough |
| Option buttons, restart button, `aria-live` stage | DecisionTree |
| Tone badge + result-card palette (`good/warn/alert`) | `.wiki-tree__badge--*`, `.wiki-tree__result--*` in wiki.css |
| "Why not X?" disclosure markup on verdict card | Reveal (`.wiki-reveal` markup emitted directly, since content is data-driven) |
| Citation resolution on verdict card | `getReference()` from `src/lib/references.ts` (same lookup Cite.astro uses) |
| Data-driven props in a typed data module | qual-roles.ts convention |

### Authoring rules (enforced by review, encoded in the data-file JSDoc)

1. Vignettes are plausible CER studies with full design info (unit, assignment, measurement, N) — sometimes the *point* is that a fact chip (e.g., "self-selected sections") changes the answer.
2. Step 1 never offers test names. Test names may appear from the middle step onward.
3. Exactly one `best` per step; every `trap` maps to a documented misconception and carries `whenRight`.
4. `defensible` feedback must state the tradeoff, not just permission.
5. At least one step or verdict per walkthrough routes *outside* the test zoo ("this is a measurement question", "this is a design limitation, not an analysis choice").
6. 3–5 steps, 3–4 options, feedback 2–4 sentences; widget budget ~4–6 min inside a 5–14 min lesson; one walkthrough per lesson (one widget per big idea).
7. Across the set, cross surface and structure: the same debugging story appears as paired/mixed (WT1), nested-binary (WT2), and measurement (WT3) designs.

---

## 2. (b) Three fully-authored walkthroughs

Field names below mirror the schema 1:1 for transcription into `quant-scenarios.ts`.

---

### WT1 — `sections-prepost` · host lesson: t-tests/ANOVA ("Comparing groups")

**title:** Two sections, pre and post

**vignette:** The lab is piloting SPRINT, a weekly debugging-exercise intervention, in CS 2. Section 1 (n = 58) gets SPRINT; Section 2 (n = 61) gets business-as-usual instruction. Every student takes the same 20-item debugging test in week 1 (pre) and week 13 (post); the score is number correct, 0–20. Students picked their own sections at registration, and the sections have different instructors. The lab head asks: "Did SPRINT improve debugging scores more than regular instruction did?"

**facts:** `Outcome: 0–20 test score` · `Pre + post, same test` · `Two intact sections, n = 58 / 61` · `Self-selected, different instructors` · `Question: improved MORE than control`

#### Step 1 — id `outcome` — "Before naming any test: what is the outcome variable here, and how should you treat it?"

- **A.** "The post-test score (0–20), treated as approximately continuous" — **best**
  - feedback: "Right read. A sum of 20 items has many possible values and behaves close enough to interval for means and regressions at this sample size — this is standard practice for course-level comparisons. Note what you did: you matched the outcome to the *question* (students' overall ability), not to the raw data format (20 binary items)."
- **B.** "Twenty separate binary items — run chi-square or logistic regression item by item" — **trap**
  - feedback: "Item-by-item analysis answers a *measurement* question — which items are hard, whether items behave — not the course-level question of whether SPRINT students improved more. It also buys you 20 tests' worth of multiple-comparison trouble for a question that needs one answer. The structural cue missed: the research question is about students, so the student-level total is the outcome."
  - whenRight: "If the lab were evaluating the *instrument* — item difficulty, discrimination, whether the test measures one thing — item-level analysis is exactly right. That is the IRT walkthrough's territory."
- **C.** "Ordinal only — sums of test items aren't truly interval, so only rank-based tests are allowed" — **trap**
  - feedback: "This is measurement-level folklore applied as a hard rule. Whether means of sum scores are trustworthy depends on test length, sample size, and floor/ceiling behavior — not on a categorical prohibition. A 20-item score with n ≈ 119 supports means and regression comfortably; a purist reading would also forbid the means and SDs every published table reports."
  - whenRight: "For a single 3-point Likert item, a tiny sample, or a score slammed against its floor or ceiling, rank-based or ordinal models genuinely earn their keep."

*note:* "Outcome settled: one roughly-continuous score per student per timepoint. Next: how those scores relate."

#### Step 2 — id `structure` — "There are four columns of scores: Sec 1 pre, Sec 1 post, Sec 2 pre, Sec 2 post. How do they actually relate?"

- **A.** "Four independent groups of scores — compare them with a 2×2 between-subjects ANOVA" — **trap**
  - feedback: "Pre and post from the *same student* are strongly correlated — the same person appears in two columns. Treating the four columns as independent both double-counts every student and throws away the precision that pairing buys you. The cue missed: repeated measurement of the same unit is never 'another group'."
  - whenRight: "If pre and post came from *different cohorts* of students (say, last year's class vs this year's), all four cells really would be independent groups."
- **B.** "Each student contributes a linked (pre, post) pair; the two sections are independent groups of students" — **best**
  - feedback: "Right read, and it's the whole design in one sentence: pairing *within* students, independence *between* sections — a mixed pre/post-with-control design. Every defensible analysis of this study is some way of respecting both halves of that sentence."
- **C.** "One group measured twice — pool both sections and test whether scores rose from pre to post" — **trap**
  - feedback: "Pooling erases the comparison the question is about. Scores rising from week 1 to week 13 could be practice effects, maturation, or test familiarity — the control section exists precisely to absorb those. The cue missed: the question is comparative ('more than regular instruction'), so the analysis must compare."
  - whenRight: "In a single-group feasibility pilot with no control, a pooled pre/post look is all you have — reported honestly as pre-experimental, with no causal language."

#### Step 3 — id `analysis` — "Which analysis answers 'did SPRINT students improve MORE than business-as-usual students'?"

- **A.** "Paired t-test on Section 1's pre vs post scores" — **trap**
  - feedback: "This shows Section 1 improved — it cannot show they improved *more than the control*. A significant within-group gain in the treatment arm is one of the most common wrong moves in published pre/post studies: practice, maturation, and re-testing all inflate it, and the control section you're ignoring is the fix. The cue missed: the counterfactual lives in Section 2."
  - whenRight: "Only if no control group existed — and then the write-up must say 'scores rose', not 'the intervention worked'."
- **B.** "Independent-samples t-test on post-test scores only" — **defensible**
  - feedback: "Defensible under *randomization*, where post-only is unbiased, just noisier. Here students chose their sections, so baseline differences are likely — ignoring the pre-test both wastes your single strongest precision covariate and lets a head start masquerade as a treatment effect. Tradeoff: simplest possible analysis, weakest use of the design."
- **C.** "Independent-samples t-test on gain scores (post − pre)" — **defensible**
  - feedback: "A solid, honest choice: it directly answers 'which section *changed* more', uses the pairing, and is easy to report. Tradeoffs: slightly less power than covariate adjustment when pre and post are imperfectly correlated, and no room to adjust for anything else. Worth reporting even when it's not the headline analysis."
- **D.** "Linear regression: post ~ pre + section (ANCOVA)" — **best**
  - feedback: "Right read — with one caveat coming. Adjusting for pre-test gives the most precise estimate of the section difference, and notice the machinery: this 'ANCOVA' is just a linear regression with a dummy variable, the same model the regression lesson builds — the independent t-test in option B is the special case with the covariate deleted. The tests-vs-models wall is thinner than the names suggest."
  - whenRight: —

*note:* "With intact (non-randomized) groups, options C and D can genuinely disagree — Lord's paradox. The verdict card returns to this."

#### Step 4 — id `assumptions` — "Section 1's post-test distribution looks left-skewed, and a Shapiro–Wilk test on it gives p = .03. What now?"

- **A.** "Switch to Mann–Whitney to be safe" — **trap**
  - feedback: "This is the two-stage ritual — test normality, then switch — and it's discredited: it distorts error rates, checks the wrong thing (the assumption concerns *residuals*, not each group's raw scores), and at n ≈ 119 the central limit theorem already protects the mean comparison. It also quietly changes the question: Mann–Whitney tests stochastic dominance, not 'difference in adjusted means'."
  - whenRight: "Chosen *a priori* for a small sample with heavy tails, where a shift-in-location question is genuinely what you want, rank-based or robust methods are respectable."
- **B.** "Plot residuals from the regression; look for outliers and ceiling effects; proceed unless something structural appears" — **best**
  - feedback: "Right read. Left skew in a 0–20 post-test usually means students bunched near the top — a *ceiling*, which is a measurement and interpretation problem (gains are compressed for strong students), not a switch-tests trigger. Assumptions are checked by looking at the model's residuals and thinking about mechanism, not by running significance tests on marginal distributions."
- **C.** "Nothing — t-tests and regressions are always robust" — **trap**
  - feedback: "Robustness is real but bounded: severe skew with small unequal groups, variance differences correlated with group size, or a hard ceiling can all bite. The habit to build is *look, then decide* — plot residuals, use Welch/robust standard errors by default — not *never look*."
  - whenRight: "Closer to true for large balanced samples with mild non-normality — which is an argument for looking once, not for a policy of never looking."

#### verdict

- **recommendation:** Fit the linear regression `post ~ pre + section` (ANCOVA) with Welch-style/robust standard errors, and report the gain-score t-test alongside it as a sensitivity analysis. Because the sections are intact, self-selected groups, agreement between the two is reassuring and disagreement is itself a finding to discuss (Lord's paradox).
- **reportingSentence:** "Adjusting for pre-test score, students in the SPRINT section scored on average [b] points higher (out of 20) on the post-test than business-as-usual students (b = [b], 95% CI [[lo], [hi]], p = [p], d ≈ [d]). A gain-score comparison agreed (mean gain [g1] vs [g2] points)."
- **caveats:**
  - "Sections were not randomized: SPRINT is confounded with instructor, meeting time, and self-selection. Write 'the SPRINT section improved more', never 'SPRINT caused the improvement'."
  - "Two sections means two clusters — too few to model section statistically; this is a design limitation the analysis cannot repair, only the write-up can acknowledge (the multilevel lesson explains why)."
  - "Lord's paradox: with intact groups, covariate adjustment and gain scores answer subtly different questions; report both."
  - "A post-test ceiling compresses gains for strong students and can bias the comparison; report the score distribution, not just means."
  - "The comparison is only as good as the score: check the test's reliability (measurement block)."
- **alternatives:**
  - "Why not repeated-measures ANOVA?" → "A 2 (time) × 2 (section) RM-ANOVA's interaction test is algebraically the gain-score t-test from option C. It isn't wrong — it's the same analysis wearing heavier clothing, and it hides rather than shows what's being compared."
  - "Why not a multilevel model?" → "MLM needs enough clusters to estimate between-cluster variance; with exactly two sections, section and treatment are the same column of the data. Nesting matters here as a *limitation*, not as a modeling opportunity."
- **lessons:** Comparing groups (host); Linear regression (`the same model, formalized`); Multilevel models (`why 2 clusters can't be modeled`); Reliability (`is the score trustworthy`).
- **citeIds:** `lord-1967`, `vanbreukelen-2006` (add to references.json — see §5).

---

### WT2 — `attempts-gee` · host lesson: Multilevel models + GEE

**title:** 462 attempts, 40 students

**vignette:** The lab's debugging-practice platform logged a study: 40 students (21 with SPRINT hint scaffolds, 19 control) each attempted the same 12 debugging exercises over four weeks. For every attempt the log records one outcome — bug fixed within 10 minutes, yes or no. Some students skipped exercises, so there are 462 attempts, not 480. The lab head asks: "Does the scaffold raise students' chances of fixing bugs, on average across students — and phrase it in plain English for the paper."

**facts:** `Outcome: fixed / not fixed per attempt` · `462 attempts from 40 students` · `Same 12 exercises for everyone` · `Treatment assigned per student` · `Some exercises skipped` · `Question: average effect across students`

#### Step 1 — id `unit` — "You have 462 rows of fixed/not-fixed. What is the independent unit here?"

- **A.** "The attempt — 462 independent observations" — **trap**
  - feedback: "Attempts by the same student share that student's skill, persistence, and prior exposure — they are correlated, not independent. Treating them as independent inflates your effective sample from 40 students to 462 rows, so standard errors come out far too small and p-values far too confident. The cue missed: the treatment was assigned *per student*, so independence lives at the student level."
  - whenRight: "If every row came from a different person — one attempt per student — rows really would be independent."
- **B.** "The student — attempts within a student are correlated" — **defensible**
  - feedback: "The right primary answer: student is the cluster that matters most, because that's where treatment was assigned. One refinement available (see the next option): students aren't the only thing rows share."
- **C.** "Both students and exercises — rows share a student's skill AND an exercise's difficulty" — **best**
  - feedback: "The sharpest read. The same 12 exercises repeat across all students, so responses are cross-classified: correlated within student and within exercise. Minimum viable handling: cluster on student and put exercise in the model (12 fixed effects, or a crossed random effect). This 'both' answer is the kind experts give and flowcharts never offer."

#### Step 2 — id `family` — "Which analysis family fits a yes/no outcome with this structure?"

- **A.** "Aggregate first: each student's proportion fixed, then a two-sample t-test (21 vs 19)" — **defensible**
  - feedback: "Honest about the unit of independence, simple, and robust — a fine sanity check, and in a balanced complete design often perfectly publishable. Tradeoffs here: a student with 6 attempts counts the same as one with 12, exercise difficulty can't be adjusted for, and skipping makes the per-student denominators uneven. Keep it as the companion analysis, not the headline."
- **B.** "Ordinary logistic regression on all 462 attempts with a treatment dummy" — **trap**
  - feedback: "Right family, wrong independence assumption. The point estimate will be roughly sensible, but the standard errors, CI, and p-value are computed as if you had 462 independent students — they will be too narrow. The cue missed: choosing the binomial family fixed the *outcome type*; it did nothing about the *dependence structure*. Those are separate decisions."
  - whenRight: "With one attempt per student, plain logistic regression is exactly the tool — see the logistic-regression lesson."
- **C.** "A binomial model that accounts for students: GEE or mixed-effects (multilevel) logistic" — **best**
  - feedback: "Right read: keep the attempt-level rows (so exercise effects stay available) and let the model carry the clustering. Which of the two — GEE or mixed logistic — is not a technicality; they estimate different quantities, and that's the next step."
- **D.** "Linear regression on the 0/1 outcome with cluster-robust standard errors (linear probability model)" — **defensible**
  - feedback: "More respectable than its reputation: with cluster-robust SEs it handles the dependence, and its coefficient is a risk *difference* ('9 percentage points more attempts fixed'), which is the plainest English available. Tradeoffs: predicted probabilities can leave [0,1], and reviewers in CER venues will expect a logistic family. Defensible; not the convention."

#### Step 3 — id `model` — "GEE vs mixed-effects logistic: what's the real difference, and which matches the lab head's question?"

- **A.** "They're interchangeable — use whichever converges" — **trap**
  - feedback: "For logistic models they estimate *different quantities* (non-collapsibility of the odds ratio): GEE gives a population-average OR — 'compare the scaffolded group's rates to the control group's' — while a mixed model gives a subject-specific OR — 'multiply a given student's odds', typically further from 1. Choosing between them is choosing what claim your paper makes, not a software preference."
  - whenRight: "For *linear* (identity-link) models the two targets coincide, and the choice really is closer to convenience."
- **B.** "GEE: logistic family, exchangeable working correlation, robust standard errors — the population-average effect" — **best**
  - feedback: "Matches the question as asked: 'on average across students' is a marginal, group-level claim, which is exactly GEE's estimand. The exchangeable working correlation is a guess the robust (sandwich) SEs forgive if wrong. One flag: 40 clusters is at the lower edge for sandwich SEs — use a small-sample correction (e.g., Mancl–DeRouen) and say so."
- **C.** "Mixed-effects logistic: random intercept per student, plus exercise effects" — **defensible**
  - feedback: "Right when you want student-level variation, crossed random effects for exercises, or per-student predictions — and its missing-data behavior is more forgiving (valid under MAR, while standard GEE leans on the stronger MCAR). Since students *did* skip exercises, that's a live tradeoff, and a good reason to run this as a sensitivity analysis. The cost: the OR becomes 'for a given student', which is not the sentence the lab head asked for."

#### Step 4 — id `report` — "The GEE returns OR = 1.9, 95% CI [1.2, 3.0] for scaffold vs control. Which sentence goes in the paper?"

- **A.** "Scaffolded students were 1.9 times more likely to fix a bug." — **trap**
  - feedback: "'Times more likely' is risk-ratio language, and an odds ratio is not a risk ratio. With outcomes this common (over half of attempts fixed), OR = 1.9 corresponds to being only about 1.3 times as likely — the OR always looks more impressive. This is one of the most frequent misreports in published quantitative work."
  - whenRight: "If the outcome were rare (a few percent), OR ≈ RR and this phrasing would be approximately harmless — still better to say 'odds'."
- **B.** "For a given student, the scaffold multiplied their odds of fixing a bug by 1.9." — **trap**
  - feedback: "That's subject-specific phrasing — the mixed-model estimand. Your GEE estimate is a statement about *group rates*, not about change within any individual student. Matching sentence to estimand is precisely why step 3 mattered."
  - whenRight: "This sentence belongs to the mixed-effects logistic OR — if you'd fit that model, this is how you'd phrase it."
- **C.** "The odds of fixing an exercise were 1.9 times higher in the scaffolded group (OR = 1.9, 95% CI [1.2, 3.0]); in terms of predicted probabilities, scaffolded students fixed about 68% of exercises versus 53% for control." — **best**
  - feedback: "Right read: odds language kept technically accurate, then translated into predicted probabilities — which is the plain-English move readers and reviewers actually want. Percentages of attempts fixed is the sentence the lab head can put in the abstract; the OR and CI are the receipts."

#### verdict

- **recommendation:** GEE logistic regression: scaffold condition + exercise fixed effects, exchangeable working correlation, robust standard errors with a small-sample correction (≈40 clusters). Report the per-student aggregate t-test as a sanity check, and a mixed-effects logistic (random intercept per student, crossed exercise effect) as a sensitivity analysis — especially because skipped exercises make GEE's missing-data assumption the weakest link.
- **reportingSentence:** "Scaffolded students fixed a higher proportion of debugging exercises than control students (predicted [p1]% vs [p0]%; GEE population-average OR = [or], 95% CI [[lo], [hi]], robust SEs corrected for [k] clusters), adjusting for exercise."
- **caveats:**
  - "40 clusters is the floor for sandwich standard errors; use and report a small-sample correction."
  - "Skipped exercises: standard GEE assumes skipping is unrelated to outcomes (≈MCAR); if weaker students skipped harder exercises, the mixed-model sensitivity analysis matters."
  - "Do not compare this OR numerically with a mixed-model OR from another paper — marginal and conditional ORs differ by construction."
  - "'Fixed within 10 minutes' dichotomizes a duration; the cutoff discards information, and a time-to-fix (survival) analysis is the richer follow-up if the cutoff was arbitrary."
  - "Treatment was assigned per student, not randomized within exercises — group differences in persistence or prior experience are uncontrolled unless measured and modeled."
- **alternatives:**
  - "Why not chi-square on the 462 attempts?" → "Same independence violation as plain logistic regression, with less flexibility — no adjustment for exercises, no CI on an effect scale you can report."
  - "Why not model each exercise separately?" → "Twelve underpowered tests and no overall answer; the whole point of GEE/mixed models is to pool evidence across exercises while respecting structure."
- **lessons:** Multilevel models + GEE (host); Logistic regression (`the family, without clustering`); GLMs (`links and families`); Comparing groups (`the aggregate t-test companion`).
- **citeIds:** `mancl-derouen-2001`, `hubbard-etal-2010` (add to references.json — see §5).

---

### WT3 — `dci-irt` · host lesson: Rasch / IRT

**title:** "Run IRT on the DCI"

**vignette:** The lab drafted a 20-item Debugging Concept Inventory (DCI), all items scored right/wrong. It was piloted in one CS 2 course: N = 150 usable response sets. The lab head says: "Run IRT so we can put the DCI's psychometrics in the paper." You have this one sample, this one course, and a deadline. What do you actually run — CTT item analysis, Rasch, or a 2PL?

**facts:** `20 dichotomous items` · `N = 150, one course, one institution` · `Instrument is new (pilot)` · `Request: "run IRT"` · `Deliverable: psychometric evidence for a paper`

#### Step 1 — id `question` — "Before any model: what question would 'running IRT' actually answer here?"

- **A.** "Whether students learned debugging this semester" — **trap**
  - feedback: "There's no comparison and no second timepoint in this data — nothing here can support a learning claim. Measurement models describe how an *instrument* behaves, not whether an intervention worked. The cue missed: instrument evaluation and outcome evaluation are different questions needing different designs."
  - whenRight: "With pre/post administrations and a comparison group, learning becomes answerable — that's the two-sections walkthrough, not this one."
- **B.** "Whether the DCI's items and scores behave well enough to support claims: item difficulty, discrimination, reliability, dimensionality" — **best**
  - feedback: "Right read: this is a measurement question. IRT is one family of tools for answering it; classical test theory is another; they overlap heavily on a 20-item pilot. The deliverable is *validity evidence* — an argument that scores mean what you claim — not a p-value."
- **C.** "IRT is the modern replacement for CTT, so fitting an IRT model is what makes the DCI 'validated'" — **trap**
  - feedback: "No single analysis validates an instrument. Validity is an argument assembled from several evidence types — content coverage, response processes, internal structure, relations to other variables — and an IRT calibration speaks only to internal structure. CTT is not obsolete: for flagging broken items in a pilot it is faster, more transparent, and assumption-lighter."
  - whenRight: "Never, as stated — but the kernel of truth is that IRT adds real value (sample-independent-ish item parameters, item information curves) once the sample can support it."

#### Step 2 — id `screening` — "First analysis to run on the 150 × 20 response matrix?"

- **A.** "Shapiro–Wilk on total scores, to check normality before IRT" — **trap**
  - feedback: "A normality ritual transplanted from t-test land. IRT models the item responses, not the total score, and no IRT decision hinges on a Shapiro–Wilk p-value. The checks that matter here are item-level and structural — difficulty, discrimination, dimensionality."
  - whenRight: "Essentially never as a gate; eyeballing the total-score distribution for floor/ceiling is still worth ten seconds."
- **B.** "CTT item analysis plus a dimensionality check: per-item proportion correct, corrected item–total (point-biserial) correlations, alpha/omega, and a parallel-analysis or factor check that one dimension dominates" — **best**
  - feedback: "Right read. This screening is cheap and catches catastrophes before any latent model: items nearly everyone or no one gets right, *negative* point-biserials (often a mis-keyed answer), and multidimensionality — which every IRT candidate you're considering assumes away. Latent models fit garbage items without complaint; CTT screening is how you notice."
- **C.** "Fit the 2PL immediately — it estimates difficulty and discrimination in one shot anyway" — **trap**
  - feedback: "The 2PL will converge and produce parameters even for broken items and a multidimensional test — it hides key errors behind strange estimates rather than flagging them. And it presumes the unidimensionality you haven't checked. Screen first, model second."
  - whenRight: "After screening, on an adequate sample, going straight to a 2PL is a perfectly normal workflow."

#### Step 3 — id `model` — "Given N = 150, which is the most ambitious item model you can defensibly report?"

- **A.** "CTT only — 150 is too small for any IRT" — **defensible**
  - feedback: "A CTT-only pilot paragraph (difficulties, discriminations, alpha/omega, distractor notes) is respectable and many published concept-inventory pilots stop there. But it's more conservative than necessary: Rasch item calibrations are usably stable from roughly 100–250 respondents, so you can go one step further with honest standard errors."
- **B.** "Rasch (1PL): one difficulty parameter per item" — **best**
  - feedback: "Right read for this N. One parameter per item keeps the demand on 150 respondents modest; you get item difficulties on a common logit scale with honest SEs, item-fit statistics that *flag* misfitting items for revision, and — because the raw score is sufficient in the Rasch model — results that speak directly to the total score instructors will actually use."
- **C.** "2PL: difficulty plus per-item discrimination" — **trap**
  - feedback: "The extra 20 discrimination parameters are where N = 150 falls down: common working guidance asks for several hundred respondents (≈500 is the usual citation) before 2PL discriminations stabilize. At this N their standard errors are wide and their rank order is noisy — and revising items based on noisy a-parameters churns the instrument on evidence that won't replicate."
  - whenRight: "On the planned multi-site administration with several hundred responses — or now, as a clearly-labeled exploratory Bayesian fit with informative priors."
- **D.** "3PL — these are multiple-choice items, so the guessing parameter is required" — **trap**
  - feedback: "Guessing is real, but the c-parameter is notoriously the hardest to estimate — it needs on the order of a thousand respondents and often misbehaves even then. At N = 150 it will not yield meaningful estimates. The cue missed: parameters must be paid for with information, and low-ability responses to hard items (where guessing shows) are exactly where a small sample is thinnest."
  - whenRight: "Large-scale administrations (assessment programs, multi-institution CIs) — or handle guessing by design: distractor analysis now, fixed/priored c later."

#### Step 4 — id `dif` — "The lab head adds: 'and check DIF by gender and by prior programming experience while you're at it.'"

- **A.** "Sure — run Mantel–Haenszel or logistic-regression DIF on the 150" — **trap**
  - feedback: "Do the arithmetic first: 150 splits into subgroups of perhaps 40 and 110 — far below the roughly 200-per-group working guidance for stable DIF detection. At this size you'll get noisy flags in both directions: items accused of DIF that aren't, and real DIF missed. Running it isn't wrong; *believing* it is."
  - whenRight: "With a couple hundred respondents per subgroup, MH or logistic DIF is exactly the standard move — the DIF lesson covers both."
- **B.** "Defer confirmatory DIF to the larger sample; at N = 150, report at most an exploratory screen, labeled as such" — **best**
  - feedback: "Right read: claims sized to the data. Put DIF in the instrument's development plan with the target subgroup sizes stated — that sentence in the limitations section is itself good psychometric practice, and reviewers reward it."
- **C.** "DIF isn't needed — the total score's reliability is already high" — **trap**
  - feedback: "Reliability and invariance are different rungs of the evidence ladder: a test can be highly internally consistent and still function differently across groups (same total score, different meaning). High alpha answers 'is the score consistent?', not 'is it fair?'."
  - whenRight: "Never — but the kernel is real: reliability evidence is a prerequisite worth reporting before invariance evidence."

#### verdict

- **recommendation:** A staged plan. Now, for the paper: CTT screening (difficulty, corrected point-biserials, alpha/omega, distractor analysis) plus a dimensionality check, then a Rasch calibration with item-fit statistics and a Wright map as the headline psychometric evidence. Explicitly deferred, in the limitations/future-work: 2PL discrimination estimates and confirmatory DIF, both waiting on the multi-institution sample.
- **reportingSentence:** "Item difficulties (proportion correct) ranged [.xx–.xx]; corrected item–total correlations ranged [.xx–.xx], with [k] items below .20 flagged for revision. Internal consistency was α = [.xx] (ω = [.xx]). A Rasch model showed acceptable fit for [n] of 20 items (infit MSQ [.xx–.xx]); item difficulties spanned [−x.x to +x.x] logits and were well targeted to the sample. The pilot sample (N = 150) supports Rasch calibration but not stable 2PL discrimination estimates or confirmatory DIF analyses; these are planned for the multi-institution administration."
- **caveats:**
  - "One course at one institution: item calibrations may not travel; say 'in this population' and mean it."
  - "N = 150 *usable* response sets — report how many were dropped and why; nonresponse can be informative."
  - "Unidimensionality is a precondition, not a finding to skip: report the check, not just the model."
  - "Internal structure is one strand of validity; the paper still needs content evidence (expert review / blueprint) and ideally response-process evidence (think-alouds) — see the instrument-development lesson."
  - "Alpha assumes tau-equivalence it rarely gets; report omega alongside it."
- **alternatives:**
  - "Why not just report alpha and move on?" → "Alpha says the items co-vary; it says nothing about which items are broken, how difficulty spans ability, or whether the score separates students — the item-level evidence is what makes a pilot paragraph convincing."
  - "Rasch vs 2PL in one sentence?" → "Rasch fixes all discriminations equal and treats misfit as a flaw *in the item* to fix; the 2PL estimates discriminations and weights items accordingly — a philosophical difference (measurement model vs statistical model) that stops being academic only when N can actually estimate the extra parameters."
- **lessons:** Rasch/IRT (host); CTT (`the screening toolkit`); Reliability (`alpha vs omega`); Validity (`the evidence argument`); DIF (`what's being deferred and why`); Instrument development (`the staged plan in full`).
- **citeIds:** `linacre-1994`, `aera-apa-ncme-2014`, `deayala-2009` (add to references.json — see §5).

---

## 3. (c) Per-lesson placement map

Not every lesson gets one: one widget per big idea, and selection-training belongs where a selection decision is the big idea. Three authored now, two premised for later, the rest deliberately none.

| Lesson (order) | Walkthrough | One-line premise / reason for none |
| --- | --- | --- |
| Overview | none | Keeps the demoted DecisionTree (§4); a walkthrough before any designs are taught would front-load schema the reader doesn't have. |
| Descriptive stats | none | Already has DistributionPlot; no selection decision is the big idea here. |
| Inference & estimation | none | Misconception coverage (p-values, CIs) fits Reveal flashcards; selection comes next lesson. |
| t-tests / ANOVA | **WT1 `sections-prepost`** | Two intact sections, pre/post — paired-vs-independent-vs-adjusted, the module's first and most scaffolded walkthrough. |
| Linear regression | none (callback) | One prose paragraph reopens WT1's verdict: "the ANCOVA you picked is this lesson's lm(post ~ pre + section)" — spaced re-encounter + the unity move, no new widget. |
| Logistic regression | none | WT2's steps 1–2 carry the family-vs-clustering teaching; this lesson forward-links to it. |
| GLMs | none | Concept lesson (links/families); WT2 lands one lesson later where the real decision lives. |
| Multilevel models + GEE | **WT2 `attempts-gee`** | 462 binary attempts from 40 students — logistic vs GEE vs mixed logistic, plus the plain-English reporting step. |
| SEM | none | "Do you even need SEM?" is a Callout; SEM selection presupposes the measurement block. |
| CTT | none (forward pointer) | WT3 reuses this lesson's tools two lessons later; a teaser line points ahead. |
| Reliability | *future WT4* | Premise: three lab artifacts (a survey scale, two graders' rubric scores, the DCI) — which coefficient: alpha/omega vs ICC vs kappa. |
| Validity | none | Argument-building, not selection; an evidence-sorting Reveal exercise fits better. |
| Rasch / IRT | **WT3 `dci-irt`** | N = 150, "run IRT" — CTT vs Rasch vs 2PL vs 3PL, sized to the sample. |
| DIF | none (callback) | Opens by replaying WT3 step 4's verdict — the second spaced re-encounter. |
| Instrument development | *future WT5* + job aid | Premise: capstone critique of a flawed pilot write-up (erroneous-example format, deliberately placed last per Große & Renkl); lesson ends with the printable one-page "which analysis" job aid — the decay countermeasure. |
| References | none | Bibliography page (Cite targets). |

---

## 4. (d) Disposition of the existing which-test DecisionTree (overview.mdx)

**Keep it, demoted from teacher to map.** The two components have different contracts, and that's the argument for keeping both: DecisionTree asks the reader about *their own* study and routes (a StatHand-style lookup aid — the format with the best evidence for point-of-need selection support); ScenarioWalkthrough fixes a vignette and trains the *reading of designs*, with feedback. Do not bolt per-option feedback onto DecisionTree — that would blur two contracts and creep the component.

Concrete edits to `/home/anavarre/Projects/ascend_website/src/content/wiki/quantitative/overview.mdx`:

1. Retitle the section "Quick test finder" and reframe the lead-in: "a map for when you already understand your design — the lessons below train the understanding," with an explicit pointer that the deep lessons contain scenario walkthroughs that explain *why* at every step.
2. Patch its two worst flowchart blind spots with two cheap additions: a first-question option "Repeated / clustered observations (same students measured many times, students inside sections)" → result routing to the MLM+GEE lesson; and an option "My question is about the instrument itself (is this test any good?)" → result routing to the measurement block. These are routing results, in keeping with DecisionTree's contract.
3. Keep results as plain text (DecisionTree renders `textContent`); add a single line under the widget linking lessons, rather than extending the component.
4. When the future job-aid page (instrument-development lesson) exists, the finder gets mirrored/linked there so the module ends with the reusable aid the decay literature calls for; the overview copy stays.

---

## 5. References to add to `src/data/references.json` (used by `citeIds` above)

`lord-1967` (Lord, "A paradox in the interpretation of group comparisons") · `vanbreukelen-2006` (ANCOVA vs change scores in randomized vs nonrandomized studies) · `mancl-derouen-2001` (small-sample GEE variance correction) · `hubbard-etal-2010` (GEE vs mixed models for population-average vs subject-specific inference) · `linacre-1994` (Rasch sample-size guidance) · `deayala-2009` (The Theory and Practice of Item Response Theory — 2PL/3PL sample demands) · `aera-apa-ncme-2014` (Standards for Educational and Psychological Testing — validity evidence types). All resolve through the existing Cite/`getReference` pipeline to `/wiki/quantitative/references`.

---

# Part 2 — GenAI toolbox spec + worked examples

# SPEC: "GenAI toolbox" recurring element — quantitative/measurement wiki module

Status: planning data. Assumes the 18-lesson numbering in §C; remap if the final lesson list differs (orders 1–2 already exist as `overview.mdx`, `descriptive-stats.mdx`).

## A. Component proposal

Two small Astro components + one data file + one CSS block. No new interactivity model — server-rendered, native `<details>`, one optional vanilla-JS copy button. The toolbox is an **aside**, not the lesson's main widget, so it does not compete with the one-widget-per-big-idea rule.

### A1. `src/components/wiki/GenAiToolbox.astro`

Styled as a distinctive Callout sibling (`.wiki-genai`, violet/indigo accent, distinct from note/tip/warning; header badge is a small "AI" monogram glyph, not an emoji). Content is data-driven and centralized so all prompts can be reviewed/updated in one file when models change.

```ts
// Usage in MDX:  import GenAiToolbox from '@wiki/GenAiToolbox.astro';
//                <GenAiToolbox id="mlm-syntax" />
interface Props { id: string }   // key into genaiToolbox record; unknown id → build-visible error text

// src/data/genai-toolbox.ts
export interface GenAiToolboxEntry {
  task: string;          // one line: what the LLM is for HERE ("Draft lme4 syntax from your design description")
  tool?: string;         // default: "VT-approved tier (Copilot, VT sign-in) — required if anything touches study data"
  prompt: string;        // full example prompt, template literal, rendered in <pre> inside <details> ("Show example prompt")
  promptNotes?: string[];// bullets: why the prompt is shaped this way (schema-not-data, asks for diagnostics, etc.)
  verify: string[];      // "Verify before trusting" checklist; rendered as static unchecked boxes — NO state, NO persistence (no-gamification rule)
  failure: string;       // known failure mode, 1–3 sentences, warning-tinted footer strip
  failureCiteIds?: string[]; // <Cite>-resolvable ids appended to the failure strip
}
export const genaiToolbox: Record<string, GenAiToolboxEntry> = { /* per-lesson entries, §C */ };
```

Layout (top→bottom): header "GenAI toolbox" + `task` · one-line `tool` tier note · `<details>` with `prompt` in `<pre>` (+ copy button, vanilla JS, ~5 lines) · `promptNotes` · "Verify before trusting" checklist · `failure` strip with cites · fixed footer link "Ground rules apply → /wiki/quantitative/overview#genai-ground-rules".

### A2. `src/components/wiki/GenAiGroundRules.astro`

Rendered once, in lesson 1 (`overview.mdx`), under heading anchor `#genai-ground-rules`. Reads `groundRules` export from the same data file; each rule `{ kind: 'do'|'dont', text: string, citeIds: string[] }`. Rendered as a two-tone list (DON'T rules first). Every toolbox footer links here — the rules are stated once, not repeated per lesson.

### A3. Supporting changes

- CSS: `.wiki-genai*` block in `wiki.css` (mirror `.wiki-callout` structure; light+dark).
- References: add policy/evidence entries to the quantitative `references.json` so `<Cite>` and the components resolve them (ids used below): `acm-authorship-2023`, `apa-genai-policy`, `icmje-2023`, `science-genai-2023`, `vt-sirc-ai`, `vt-doit-2025`, `ptac-deid`, `nsf-genai-2023`, `nih-not-od-23-149`, `walters-wilder-2023`, `chelli-2024`, `kabir-2024`, `ruta-2025`, `chhikara-2025`, `dobler-2025`, `perkel-2023`, `tripod-llm-2025`, `smith-tenrules-2024`, `finnie-ansley-2022`, `savelka-2023`, `kortemeyer-2025`, `kuchemann-2024`, `prather-2023`, `pangakis-2023`, `glynn-academ-ai`.
- Note for authoring: ACM FAQ wording should be spot-checked against the live acm.org page before the references entry is finalized (digest was built from secondary republication).

## B. Module-wide ground rules (content for `groundRules`, each traceable)

DON'T
1. Never paste anything a participant gave you — transcripts, survey free-text, code submissions, grades, emails — into a public AI tool. Pasting is disclosure to a third party and can void your protocol's confidentiality provisions. [vt-sirc-ai; UCSF HRPP pattern]
2. "I deleted the names" is not de-identified. FERPA's bar counts indirect identifiers, small cells, and free text ("the one woman in the 8am section" is identifiable; code style is an identifier). Use an identifier checklist (HIPAA's 18 categories is a usable start). [ptac-deid; HIPAA Safe Harbor]
3. Don't cite anything an LLM told you about until you have retrieved and read it. Measured fabrication: 18–55% of GPT-generated citations; fakes pair real author names with invented titles, so eyeballing fails. [walters-wilder-2023; chelli-2024]
4. Don't treat the model's confidence as evidence. Models state ~88% confidence while ~79% correct, and are most fluent when wrong; verification is external, never self-report. [chhikara-2025; dobler-2025]
5. Never upload a manuscript, proposal, or anything you are reviewing. ACM, NSF, and NIH all prohibit putting others' confidential work into third-party AI tools. [acm-authorship-2023 (reviewer rules); nsf-genai-2023; nih-not-od-23-149]

DO
6. Use the university-approved tool tier (at VT: Microsoft Copilot signed in with your VT account) for anything touching research or student data; use the lowest-risk data that meets the need. [ai.vt.edu approved tools; vt-doit-2025]
7. Prompt with the schema, not the data: variables, design, constraints; ask for assumptions, diagnostics, effect sizes, and "what could be wrong," not reassurance. Prompt specificity moved inferential accuracy 32.5%→92.5% in validation. [ruta-2025; perkel-2023; dobler-2025]
8. The code is the artifact of record. The chat is not the analysis; every reported number must regenerate from a script in the repo, run by you. Half of ChatGPT programming answers contained errors; readers overlooked them 39% of the time. [tripod-llm-2025; smith-tenrules-2024; kabir-2024]
9. Keep a 4-line AI-use log per use: date · tool + model/version · what it was used for · how output was verified. This is exactly what APA citation format and Science-level disclosure require (Science asks for the full prompt). [apa-genai-policy; science-genai-2023; tripod-llm-2025]
10. Disclose per venue, own everything you submit. ACM: Acknowledgements statement; APA journals: Method + reference-list citation; AI is never an author anywhere; when unsure, err toward disclosing. Accountability stays with you, and journals actively detect undisclosed use. [acm-authorship-2023; apa-genai-policy; icmje-2023; glynn-academ-ai]

## C. Per-lesson example map (lessons 1–18)

| # | Lesson | Toolbox? | Entry id / element | Task | Known failure mode (cite) |
|---|---|---|---|---|---|
| 1 | Overview | No toolbox | `<GenAiGroundRules />` box | — | — |
| 2 | Descriptive stats | YES | `desc-code` | Draft dplyr/ggplot summary+plot code from a schema description of the debugging-study export; rerun everything | Chat-computed means/SDs are wrong often enough to matter; arithmetic is not a strength (kabir-2024) |
| 3 | Inference (CIs, p, power) | No | — | Concept lesson; nothing executable to verify against, and outsourcing the concepts defeats the competence prerequisite (dobler-2025) | — |
| 4 | t-tests | YES | `ttest-assumptions` | Schema prompt: t-test code that must include assumption checks (normality of differences, variance), effect size + CI — the Ruta "specific prompt" pattern | Basic prompts get inferential setups wrong ~2/3 of the time; specificity is the fix (ruta-2025) |
| 5 | ANOVA | No (pointer) | one-line Callout | "Reuse the lesson-4 prompt pattern; swap the model" — no second toolbox for the same skill | — |
| 6 | Linear regression | YES | `lm-whats-wrong` | Paste your model formula + design (not data); ask "what could be wrong with this analysis?" — diagnostics, influence, omitted confounders | Model agrees confidently with whatever you fit; confidence is not evidence (chhikara-2025) |
| 7 | Logistic regression | YES | `logistic-translate` | Plain-language translation of YOUR verified output for an instructor audience — worked example §D2 | OR↔probability conflation: "OR 1.86" rendered as "86% more likely" (digest §3 stats-reasoning line) |
| 8 | GLMs (counts etc.) | YES (light) | `glm-errors` | Paste the convergence warning / error message (never the data); ask what it means and what to check — scoped-to-strengths use | Suggested "fixes" that silence the warning without addressing the cause |
| 9 | Multilevel models | YES | `mlm-syntax` | lme4 syntax scaffolding from a design description (students in sections in semesters); ask for the random-effects options and tradeoffs, not one answer | Plausible-but-wrong random-effects structure; advanced uses require enough background to check the output (dobler-2025) |
| 10 | GEE | No (pointer) | one-line Callout | "Same scaffolding pattern with geepack; correlation-structure choice is yours" (if MLM+GEE merge into one lesson, `mlm-syntax` covers both) | — |
| 11 | SEM | YES | `sem-lavaan` | lavaan syntax from your drawn path model; require model-implied df/parameter count in comments so you can hand-check identification | Invented lavaan operators/arguments; silently non-default estimator; hand-check df before trusting fit |
| 12 | Measurement foundations / CTT | No | — | Concept lesson | — |
| 13 | Reliability (alpha/omega) | YES | `alpha-omega` | psych::alpha + omega code for dci-pilot.csv (schema only); cross-check the two packages against each other | LLM "computes" alpha in-chat or misstates tau-equivalence assumptions; rerun in code (kabir-2024) |
| 14 | Validity | No | — | Validity argumentation is human judgment (Kane); an LLM summary is where fluent overclaiming bites hardest | — |
| 15 | Rasch/IRT | YES | `mirt-calibration` | Draft mirt calibration code — worked example §D1 | Hallucinated function arguments / stale mirt API; fits 2PL without checking unidimensionality |
| 16 | DIF | YES | `dif-code` + a Reveal mini-exercise | difR/mirt DIF code from schema; PLUS live exercise: ask an LLM for 5 DIF references, then try to retrieve each (expected hit rate makes rule 3 visceral) | 18–55% fabricated citations; real authors, fake titles (walters-wilder-2023; chelli-2024) |
| 17 | Instrument development (DCI) | YES | `item-drafting` + dedicated warning Callout | LLM-assisted item drafting for parallel forms — every item goes through expert review + cognitive interviews (Willis & Artino); human panel is non-negotiable (kuchemann-2024 shows near-human quality, not equal) | Separate `Callout type="warning"` (not the toolbox): **test security/contamination** — GPT-4-class models solve CS1 exams and concept inventories above post-instruction undergrads (finnie-ansley-2022; savelka-2023; kortemeyer-2025); any unproctored DCI administration can't separate student ability from AI assistance, and pre/post gains can be contaminated. This threatens the instrument's validity argument, not just one analysis |
| 18 | Reporting & reading results | YES (light) | `disclosure-draft` | Draft the venue-specific disclosure statement (ACM Acknowledgements vs APA Method wording) from your AI-use log; hallucinated-references warning repeated for related-work searches | Undisclosed use is being actively detected (glynn-academ-ai); LLM-suggested related work must be retrieved before citing (walters-wilder-2023) |

12 toolboxes; 6 lessons deliberately without (1, 3, 5, 10, 12, 14 — stated rationale above; skips are as instructive as inclusions and prevent the element becoming wallpaper).

## D. Two fully-worked examples (final `genai-toolbox.ts` content)

### D1. `mirt-calibration` (lesson 15)

**task:** "Draft the R calibration script for the DCI pilot — the LLM writes code, you run and check everything."
**tool:** "Any tier is fine — this prompt contains the schema only, never the data."

**prompt:**

```
You are helping with item response theory calibration in R. Do not compute
any statistics yourself — write R code only.

Data: dci-pilot.csv — pilot responses to a 20-item Debugging Concept
Inventory. N = 212 CS1 students. Columns: id (arbitrary participant code),
i01–i20 (item scores, 0 = incorrect, 1 = correct). Missing values are NA
only. The file contains no identifiers beyond the arbitrary code and no
demographic columns.

Write one R script using the mirt package (assume mirt >= 1.41) that:
1. Loads the CSV and drops id before modeling; prints nrow() before and
   after any filtering so nothing is dropped silently.
2. Checks unidimensionality first (eigenvalues / EFA on tetrachoric
   correlations) and says in a comment what pattern would justify
   proceeding.
3. Fits a unidimensional Rasch model and a 2PL, compares them with
   anova() and AIC/BIC.
4. Reports item parameters (a, b) with standard errors as a tidy data
   frame.
5. Runs item fit (S-X2) and flags items by the cutoff you use — state
   the cutoff in a comment and where it comes from.
6. Checks local dependence (Q3 or LD-X2) and flags pairs; state the
   cutoff and its source.
7. Plots the test information function and all ICCs.
8. Ends with sessionInfo().

Comment each step with what it does and what I should look at in the
output. Where N = 212 is a limitation (especially for 2PL slope SEs),
say so in a comment instead of silently working around it.
```

**promptNotes:**
- Schema, never data — the CSV stays on your machine (ground rules 1–2, 7).
- "Write code, don't compute" forces verify-by-execution (rule 8).
- Pins package + minimum version; asks for cutoffs *with sources* so hallucinated conventions surface as checkable claims.
- Asks for limitations in comments — "what could be wrong," not "is this right."

**verify:**
- [ ] Run the script top-to-bottom in a fresh R session. Only your console output counts; anything the chat claims the output "will show" is noise.
- [ ] Check every function/argument against the installed docs (`?itemfit`, `?residuals.SingleGroupClass`) — mirt's argument names have changed across versions and LLMs mix eras.
- [ ] Cross-check with a second package: refit the Rasch model in eRm or TAM and correlate item difficulties with mirt's b's. Also sanity-check that b ordering roughly matches classical p-values.
- [ ] Read the SEs yourself: N = 212 is thin for 2PL slopes. Do not accept the model's verbal reassurance about sample size.
- [ ] Retrieve the source for every cutoff the script cites (Q3, S-X2 thresholds) before adopting it — cutoffs and their citations are a known fabrication zone.
- [ ] Confirm row counts before/after loading match your records; confirm NA handling is what you intended.
- [ ] Log it: date, tool + model/version, "drafted mirt calibration script," "verified by rerun + eRm cross-check."

**failure:** "Plausible-but-nonexistent function arguments and stale mirt API calls that error — or worse, run with different semantics than the comment claims. Second-order failure: fitting the 2PL without ever checking unidimensionality. Models pick the right analysis reliably; execution details are where they break." **failureCiteIds:** kabir-2024, ruta-2025.

### D2. `logistic-translate` (lesson 7)

**task:** "Turn your verified logistic output into a sentence an instructor understands — the LLM translates your numbers; it never computes them."
**tool:** "Any tier — the prompt contains only your model summary, no participant data."

**prompt:**

```
You are helping translate a statistical result into plain language for a
university CS instructor with no statistics background. Do not recompute,
convert, or embellish any number, and do not use causal language beyond
what I state the design supports.

Design: randomized controlled trial. CS1 students were randomly assigned
to a debugging-strategy intervention (n = 143) or business-as-usual lab
(n = 141). Outcome: passing the course. Model: logistic regression of
pass on condition, adjusting for prior GPA.

Verified results from my own R output:
- Adjusted odds ratio, intervention vs control: 1.86, 95% CI [1.12, 3.09],
  p = .016
- Model-predicted pass probability at mean prior GPA: control 71%,
  intervention 82% (computed by me with marginal effects — use these,
  do not derive your own)

Draft 3 candidate sentences that:
1. Lead with the predicted-probability difference in percentage points,
   not the odds ratio.
2. Convey uncertainty without the words "odds," "significant," or
   "confidence interval."
3. Make clear this is one study in one course.
Then, for each sentence, list what it leaves out, so I can judge the
tradeoff myself.
```

**promptNotes:**
- All numbers come from the RA's verified run; predicted probabilities are pre-computed by the RA because OR→probability conversion is precisely where LLMs slip.
- Explicit causal-language constraint tied to the stated design (RCT here; for observational data the prompt must say so and ban causal verbs).
- Asks for options + omissions, not one authoritative sentence — the judgment stays human.

**verify:**
- [ ] Every number in each draft matches your R output digit-for-digit; models "helpfully" round and convert.
- [ ] Conflation check: nothing renders "OR 1.86" as "86% more likely to pass." The only probability statements are your 71%/82% marginal-effects figures.
- [ ] Causal-scope check: verbs match the design (RCT supports "led to"; strike it for anything observational).
- [ ] Uncertainty survived translation — the clean sentence still carries "the study can't pin down the exact size" or equivalent.
- [ ] Read-aloud test with a non-stats colleague or the PI — the audience check no model can do.
- [ ] If the sentence lands in a paper: this is generated text → venue disclosure (ACM Acknowledgements / APA Method) + AI-use log entry.

**failure:** "Odds-ratio-to-probability conflation and fluent overclaiming: the most readable draft is often the one that quietly upgraded your effect size or dropped the uncertainty. Readers prefer polished wrong answers and miss the errors about 39% of the time — so the polish is the risk." **failureCiteIds:** kabir-2024, chhikara-2025.

## Implementation notes

- New files: `src/components/wiki/GenAiToolbox.astro` (~90 lines), `src/components/wiki/GenAiGroundRules.astro` (~40 lines), `src/data/genai-toolbox.ts` (12 entries + `groundRules`).
- Edits: `wiki.css` (`.wiki-genai*` block), quantitative `references.json` (~25 entries, §A3 ids), lesson MDX files as written.
- No progress/state anywhere: checklist boxes are decorative glyphs; `<details>` is native; only JS is the optional copy button.
- Consistency rule for authors: one toolbox per lesson max; prompts always schema-only; every `failure` field must carry at least one cite id so the warning is evidence, not vibes.

---

# Part 3 — Complete citation harvest


## Test/model-selection pedagogy (walkthrough design)

- **Allen, Dorozenko & Roberts 2016** — Difficult Decisions: A Qualitative Exploration of the Statistical Decision Making Process from the Perspectives of Psychology Students and Academics. *Frontiers in Psychology*, 2016. [✓ verified; free] <https://doi.org/10.3389/fpsyg.2016.00188>
  - Cite for how students actually go wrong (superficial, keyword-driven, no articulable process) vs. experts' systematic question-first process; justifies externalizing the expert decision procedure in walkthroughs.
- **Allen et al. 2019** — An Experimental Evaluation of StatHand: A Free Application to Guide Students' Statistical Decision Making. *Scholarship of Teaching and Learning in Psychology*, 2019. [✓ verified] <https://research-information.bris.ac.uk/en/publications/an-experimental-evaluation-of-stathand-a-free-application-to-guid/>
  - RCT (n=217): interactive one-question-at-a-time decision aid beat textbook and paper flowchart on accuracy (δ .50–.64) with lower cognitive load — the evidence base for interactive walkthroughs over static charts.
- **Quilici & Mayer 1996** — Role of Examples in How Students Learn to Categorize Statistics Word Problems. *Journal of Educational Psychology 88(1), 144–161*, 1996. [✓ verified] <https://doi.org/10.1037/0022-0663.88.1.144>
  - Surface vs. structural features in statistics problem categorization; structure-emphasizing example sets (crossing stories with test structures) improve selection — the core principle for scenario design.
- **Castro Sotos et al. 2007** — Students' Misconceptions of Statistical Inference: A Review of the Empirical Evidence from Research on Statistics Education. *Educational Research Review 2(2), 98–113*, 2007. [✓ verified] <https://doi.org/10.1016/j.edurev.2007.04.001>
  - Catalog of documented inference misconceptions — the source for writing distractors and distractor-specific feedback.
- **Renkl & Atkinson 2003** — Structuring the Transition From Example Study to Problem Solving in Cognitive Skill Acquisition: A Cognitive Load Perspective. *Educational Psychologist 38(1), 15–22*, 2003. [✓ verified] <https://doi.org/10.1207/S15326985EP3801_3>
  - Fading/backward-fading of worked steps + self-explanation prompts — the template for sequencing walkthroughs from fully modeled to independent.
- **Shute 2008** — Focus on Formative Feedback. *Review of Educational Research 78(1), 153–189*, 2008. [✓ verified] <https://doi.org/10.3102/0034654307313795>
  - Guidelines for elaborated, task-specific, immediate feedback — governs how per-option feedback should be written.
- **GAISE College Report ASA Revision Committee 2016** — Guidelines for Assessment and Instruction in Statistics Education (GAISE) College Report 2016. *American Statistical Association*, 2016. [✓ verified; free] <https://www.amstat.org/asa/files/pdfs/GAISE/GaiseCollege_Full.pdf>
  - Six recommendations incl. multivariable thinking and statistics-as-investigative-process; cite to justify design-question-first and multivariable branches in walkthroughs.
- **Allen, Roberts et al. 2016** — Introducing StatHand: A Cross-Platform Mobile Application to Support Students' Statistical Decision Making. *Frontiers in Psychology*, 2016. [free] <https://doi.org/10.3389/fpsyg.2016.00288>
  - Reviews limitations of paper/textbook decision trees (brevity, definitions separated from decision points, static) and the structural-characteristics design of StatHand.
- **Allen et al. 2022** — Training Structural Awareness with StatHand: A 1 Year Follow-Up. *Teaching of Psychology 49(4)*, 2022. <https://doi.org/10.1177/0098628320985080>
  - Structural-awareness gains persist ~1 year but statistic-selection skill decays — motivates job aids and spaced re-practice.
- **Gardner & Hudson 1999** — University Students' Ability to Apply Statistical Procedures. *Journal of Statistics Education 7(1)*, 1999. [free] <https://doi.org/10.1080/10691898.1999.12131264>
  - Scenario study showing post-course students largely cannot map research scenarios to procedures; identifies error patterns.
- **Ware & Chastain 1991** — Developing Selection Skills in Introductory Statistics. *Teaching of Psychology 18(4), 219–222*, 1991. <https://doi.org/10.1207/s15328023top1804_4>
  - Classic evidence that explicitly teaching when-to-use (selection skills) improves scenario-based selection versus computation-focused instruction.
- **delMas, Garfield, Ooms & Chance 2007** — Assessing Students' Conceptual Understanding After a First Course in Statistics. *Statistics Education Research Journal 6(2), 28–58*, 2007. [free] <https://www.stat.auckland.ac.nz/~iase/serj/SERJ6(2)_delMas.pdf>
  - CAOS instrument: misconception-based distractors in scenario items; pre/post data showing persistent and even worsening misconceptions — model for widget item writing.
- **ARTIST Project (delMas, Garfield, Chance, Ooms)** — Assessment Resource Tools for Improving Statistical Thinking (item database incl. 'selecting appropriate procedure'). *University of Minnesota / NSF*, 2006. [free] <https://apps3.cehd.umn.edu/artist/>
  - Item bank to mine for scenario-item formats and distractors on procedure selection.
- **Garfield 2002** — The Challenge of Developing Statistical Reasoning. *Journal of Statistics Education 10(3)*, 2002. [free] <https://jse.amstat.org/v10n3/garfield.html>
  - Defines statistical reasoning vs. procedures, catalogs correct/incorrect reasoning types; supports assessing the 'why' at each step.
- **Hoekstra, Kiers & Johnson 2012** — Are Assumptions of Well-Known Statistical Techniques Checked, and Why (Not)?. *Frontiers in Psychology 3:137*, 2012. [free] <https://doi.org/10.3389/fpsyg.2012.00137>
  - Researchers rarely check assumptions and misuse preliminary tests — justifies building assumption checks into the decision path while debunking the normality-test ritual.
- **Sanders et al. 2019** — Inferential Statistics in Computing Education Research: A Methodological Review. *ICER 2019 (ACM)*, 2019. <https://doi.org/10.1145/3291279.3339408>
  - What CER actually uses (t, chi-squared, MWW) and its reporting deficiencies — grounds scenarios in the lab's own field.
- **UCLA OARC Statistical Consulting** — Choosing the Correct Statistical Test in SAS, Stata, SPSS and R. *UCLA OARC (formerly IDRE)*, n.d.. [free] <https://stats.oarc.ucla.edu/other/mult-pkg/whatstat/>
  - Benchmark decision table (DV count, IV number/type, DV type → test + software examples); strengths and its variable-inventory-first limitation.
- **GraphPad/Motulsky** — Choosing a Statistical Test (Intuitive Biostatistics excerpt / FAQ 1790). *GraphPad Software*, n.d.. [free] <https://www.graphpad.com/support/faqid/1790/>
  - Goal + outcome-type-first organization; candid caveats (parametric choice matters less at large N; normality tests a poor gate) — model for honest 'it depends' feedback.
- **Statkat** — Statkat — Statistical Method Selection Tool and Methods Comparison Tool. *statkat.com*, n.d.. [free] <https://statkat.com/>
  - Question-led selection + uniform per-test template (hypotheses, assumptions, statistic, how-to) + side-by-side test comparison — the comparison view is worth stealing.
- **McElreath 2020** — Statistical Rethinking, 2nd ed., Ch. 1 'The Golem of Prague'. *CRC Press*, 2020. <https://www.routledge.com/Statistical-Rethinking-A-Bayesian-Course-with-Examples-in-R-and-STAN/McElreath/p/book/9780367139919>
  - Canonical critique of flowchart/test-zoo pedagogy: hides unity of methods, breeds 'correct test' anxiety, collapses off-chart.
- **Lindeløv 2019** — Common Statistical Tests Are Linear Models (or: How to Teach Stats). *Self-published (lindeloev.github.io)*, 2019. [free] <https://lindeloev.github.io/tests-as-linear/>
  - t/ANOVA/correlation (and rank analogs) as special cases of the linear model — supports a 'tests are models' walkthrough bridging to the module's regression/MLM arc.
- **Hand 1994** — Deconstructing Statistical Questions. *Journal of the Royal Statistical Society Series A 157(3), 317–356*, 1994. <https://doi.org/10.2307/2983526>
  - The error-prone step is translating the substantive question into a statistical one — flowcharts start after it; justifies question-formulation nodes.
- **Wild & Pfannkuch 1999** — Statistical Thinking in Empirical Enquiry. *International Statistical Review 67(3), 223–248*, 1999. [free] <https://www.stat.auckland.ac.nz/~iase/publications/isr/99.Wild.Pfannkuch.pdf>
  - Investigative/interrogative-cycle framework; situates analysis choice inside the whole enquiry cycle (matches GAISE framing).
- **Paas 1992** — Training Strategies for Attaining Transfer of Problem-Solving Skill in Statistics: A Cognitive-Load Approach. *Journal of Educational Psychology 84(4), 429–434*, 1992. <https://doi.org/10.1037/0022-0663.84.4.429>
  - Worked/completion examples beat conventional problem solving for transfer in the statistics domain specifically.
- **Atkinson, Derry, Renkl & Wortham 2000** — Learning from Examples: Instructional Principles from the Worked Examples Research. *Review of Educational Research 70(2), 181–214*, 2000. <https://doi.org/10.3102/00346543070002181>
  - Inter/intra-example design principles: multiple varied examples per schema, example–problem pairs, subgoal labels.
- **Große & Renkl 2007** — Finding and Fixing Errors in Worked Examples: Can This Foster Learning Outcomes?. *Learning and Instruction 17(6), 612–634*, 2007. <https://doi.org/10.1016/j.learninstruc.2007.09.008>
  - Erroneous examples help only higher-prior-knowledge learners; error highlighting aids novices — place 'critique the flawed analysis' late and always explain errors.
- **Quilici & Mayer 2002** — Teaching Students to Recognize Structural Similarities Between Statistics Word Problems. *Applied Cognitive Psychology 16(3), 325–342*, 2002. <https://doi.org/10.1002/acp.796>
  - Brief structural-recognition training improves categorization of statistics problems — direct support for structure-focused widget prompts.
- **Lovett, Meyer & Thille 2008** — The Open Learning Initiative: Measuring the Effectiveness of the OLI Statistics Course in Accelerating Student Learning. *Journal of Interactive Media in Education*, 2008. [free] <https://doi.org/10.5334/2008-14>
  - Interactive scaffolded statistics practice (StatTutor) halved learning time with equal/better outcomes — existence proof for interactive practice with feedback.
- **Carver et al. 2017 (arXiv companion)** — Updated Guidelines, Updated Curriculum: The GAISE College Report and Introductory Statistics for the Modern Student. *CHANCE / arXiv:1705.09530*, 2017. [free] <https://arxiv.org/abs/1705.09530>
  - Accessible summary of GAISE 2016 changes (multivariable thinking, investigative process) if the full report is too long to cite in-line.

## Regression, GLM, GEE, MLM, SEM, reporting standards

- **Gelman, Hill & Vehtari 2020** — Regression and Other Stories. *Cambridge University Press (official free PDF)*, 2020. [✓ verified; free] <https://users.aalto.fi/~ave/ROS.pdf>
  - Free workhorse for the linear-regression lesson (ch. 10 interactions, ch. 11 diagnostics) and a free citable source for the divide-by-4 rule (sec. 13.2)
- **Fox 2020** — Regression Diagnostics: An Introduction (2nd ed., QASS #79). *Sage*, 2020. <https://us.sagepub.com/en-us/nam/regression-diagnostics/book269026>
  - Canonical short chapter-level diagnostics reference for social scientists; 2nd ed. adds GLM diagnostics
- **Brambor, Clark & Golder 2006** — Understanding Interaction Models: Improving Empirical Analyses. *Political Analysis 14(1):63-82*, 2006. [free] <https://mattgolder.com/interactions>
  - Free classic checklist for specifying/interpreting interaction terms; cite in the interactions section
- **Aiken & West 1991** — Multiple Regression: Testing and Interpreting Interactions. *Sage*, 1991.
  - Provenance citation for centering and simple-slopes analysis; teach from freer sources
- **Norton, Dowd & Maciejewski 2018** — Odds Ratios—Current Best Practice and Use. *JAMA 320(1):84-85*, 2018. <https://doi.org/10.1001/jama.2018.6971>
  - Confirmed details; cite as the authoritative 'stop over-interpreting odds ratios' statement in the logistic lesson
- **Norton & Dowd 2018** — Log Odds and the Interpretation of Logit Models. *Health Services Research 53(2):859-878*, 2018. [free] <https://doi.org/10.1111/1475-6773.12712>
  - Free (PMC) longer companion to the JAMA piece; better wiki link for students
- **Mize 2019** — Best Practices for Estimating, Interpreting, and Presenting Nonlinear Interaction Effects. *Sociological Science 6:81-117*, 2019. [✓ verified; free] <https://sociologicalscience.com/articles-v6-4-81/>
  - Core reading for interactions in logit models via predicted probabilities; OA with Stata/R replication files
- **Arel-Bundock, Greifer & Heiss 2024** — How to Interpret Statistical Models Using marginaleffects for R and Python. *Journal of Statistical Software 111(9):1-32*, 2024. [✓ verified; free] <https://doi.org/10.18637/jss.v111.i09>
  - Confirmed JSS 2024; the practical tooling reference for predictions/marginal effects; free book at marginaleffects.com
- **Long & Freese 2014** — Regression Models for Categorical Dependent Variables Using Stata (3rd ed.). *Stata Press*, 2014. <https://www.stata.com/bookstore/regression-models-categorical-dependent-variables/>
  - Canonical interpretation-via-predictions text (Stata-specific); deep reference for the logistic lesson
- **Gelman & Hill 2007** — Data Analysis Using Regression and Multilevel/Hierarchical Models. *Cambridge University Press*, 2007. <https://sites.stat.columbia.edu/gelman/arm/>
  - Divide-by-4 rule source (sec. 5.1, p. 82) and canonical MLM text; multilevel half not yet superseded by free ROS
- **Knol et al. 2012** — Overestimation of risk ratios by odds ratios in trials and cohort studies: alternatives to logistic regression. *CMAJ 184(8):895-899*, 2012. [free] <https://pmc.ncbi.nlm.nih.gov/articles/PMC3348192/>
  - Free evidence + alternatives (log-binomial, robust Poisson) for the odds-ratio misreporting segment
- **Voas 2025** — The odds are it's wrong: Correcting a common mistake in statistics. *Teaching Statistics*, 2025. <https://doi.org/10.1111/test.12391>
  - Teaching-oriented piece on OR-vs-RR misreading in courses and student papers; access unverified
- **Liang & Zeger 1986** — Longitudinal data analysis using generalized linear models. *Biometrika 73(1):13-22*, 1986. <https://doi.org/10.1093/biomet/73.1.13>
  - The original GEE paper; cite for provenance only, not as a reading
- **Hubbard et al. 2010** — To GEE or Not to GEE: Comparing Population Average and Mixed Models for Estimating the Associations Between Neighborhood Risk Factors and Health. *Epidemiology 21(4):467-474*, 2010. <https://doi.org/10.1097/EDE.0b013e3181caeb90>
  - Confirmed; the GEE-vs-mixed-model framing paper; argues population-average models often better match the inferential target
- **Hanley et al. 2003** — Statistical Analysis of Correlated Data Using Generalized Estimating Equations: An Orientation. *American Journal of Epidemiology 157(4):364-375*, 2003. [free] <https://doi.org/10.1093/aje/kwf215>
  - Most accessible worked-example GEE intro; accessible full text at OUP
- **McNeish, Stapleton & Silverman 2017** — On the Unnecessary Ubiquity of Hierarchical Linear Modeling. *Psychological Methods 22(1):114-140*, 2017. [✓ verified; free] <http://www.stat-help.com/McNeish%20et%20al.%20(2017).pdf>
  - Free author PDF; the population-averaged vs subject-specific explainer bridging the GEE and MLM lessons for behavioral scientists
- **McNeish & Stapleton 2016 (MBR)** — Modeling Clustered Data with Very Few Clusters. *Multivariate Behavioral Research 51(4):495-518*, 2016. <https://doi.org/10.1080/00273171.2016.1167008>
  - Small-sample guidance covering BOTH GEE bias-corrected sandwich estimators and MLM fixes
- **Thompson et al. 2021** — Comparison of small-sample standard-error corrections for generalised estimating equations in stepped wedge cluster randomised trials with a binary outcome. *Statistical Methods in Medical Research 30(2)*, 2021. [free] <https://pmc.ncbi.nlm.nih.gov/articles/PMC8008420/>
  - Free practical rule: with <50 clusters use KC/FG-type corrected SEs; corrections rarely used in practice
- **Hox, Moerbeek & van de Schoot 2017** — Multilevel Analysis: Techniques and Applications (3rd ed.). *Routledge*, 2017. <https://multilevel-analysis.sites.uu.nl/>
  - Canonical applied MLM text; book paywalled but companion site has free tutorials and data worth linking
- **Raudenbush & Bryk 2002** — Hierarchical Linear Models: Applications and Data Analysis Methods (2nd ed.). *Sage*, 2002.
  - Canonical HLM citation in education research; provenance reference, not a student reading
- **McNeish & Stapleton 2016 (EPR)** — The Effect of Small Sample Size on Two-Level Model Estimates: A Review and Illustration. *Educational Psychology Review 28(2):295-314*, 2016. <https://doi.org/10.1007/s10648-014-9287-x>
  - The requested small-number-of-clusters review with remedies, education-journal framing
- **Theobald 2018** — Students Are Rarely Independent: When, Why, and How to Use Random Effects in Discipline-Based Education Research. *CBE—Life Sciences Education 17(3):rm2*, 2018. [✓ verified; free] <https://doi.org/10.1187/cbe.17-12-0280>
  - Free DBER-native MLM intro (students nested in sections/terms/years); the best-fit first reading for the MLM lesson
- **Van Dusen & Nissen 2019** — Modernizing Use of Regression Models in Physics Education Research: A Review of Hierarchical Linear Modeling. *Physical Review Physics Education Research 15:020108*, 2019. [free] <https://doi.org/10.1103/PhysRevPhysEducRes.15.020108>
  - Free PER example of single-level vs HLM across 112 courses; closest analogue to a multi-section debugging-intervention study
- **Sommet & Morselli 2017** — Keep Calm and Learn Multilevel Logistic Modeling: A Simplified Three-Step Procedure Using Stata, R, Mplus, and SPSS. *International Review of Social Psychology 30(1):203-218*, 2017. [free] <https://doi.org/10.5334/irsp.90>
  - Free turnkey multilevel-logistic walkthrough with syntax in four packages; ideal for pass/fail outcomes across sections
- **Kline 2023** — Principles and Practice of Structural Equation Modeling (5th ed.). *Guilford Press*, 2023. <https://www.guilford.com/books/Principles-and-Practice-of-Structural-Equation-Modeling/Rex-Kline/9781462551910>
  - Confirmed 5th ed. (2023) is current; now lavaan-centric and adds Pearl SCM + composite SEM; the canonical SEM textbook citation
- **Rosseel 2012** — lavaan: An R Package for Structural Equation Modeling. *Journal of Statistical Software 48(2):1-36*, 2012. [✓ verified; free] <https://doi.org/10.18637/jss.v48.i02>
  - Free; cite wherever lavaan is used, including the Debugging Concept Inventory CFA example
- **Hu & Bentler 1999** — Cutoff Criteria for Fit Indexes in Covariance Structure Analysis: Conventional Criteria versus New Alternatives. *Structural Equation Modeling 6(1):1-55*, 1999. <https://doi.org/10.1080/10705519909540118>
  - Source of the CFI/RMSEA/SRMR cutoff conventions; pair with Marsh et al. 2004 critique; PDF circulates freely
- **Marsh, Hau & Wen 2004** — In Search of Golden Rules: Comment on Hypothesis-Testing Approaches to Setting Cutoff Values for Fit Indexes and Dangers in Overgeneralizing Hu and Bentler's (1999) Findings. *Structural Equation Modeling 11(3):320-341*, 2004. <https://doi.org/10.1207/s15328007sem1103_2>
  - The requested cutoff critique: constants from a narrow 3-factor CFA simulation should not be universal laws
- **Beran & Violato 2010** — Structural equation modeling in medical research: a primer. *BMC Research Notes 3:267*, 2010. [free] <https://doi.org/10.1186/1756-0500-3-267>
  - Free CC-BY gentle SEM primer; education-specific equivalents are paywalled, so this is the accessible on-ramp
- **Appelbaum et al. 2018** — Journal Article Reporting Standards for Quantitative Research in Psychology: The APA Publications and Communications Board Task Force Report. *American Psychologist 73(1):3-25*, 2018. [free] <https://www.apa.org/pubs/journals/releases/amp-amp0000191.pdf>
  - JARS-Quant confirmed; APA hosts free PDF and free checklists at apastyle.apa.org/jars — link the checklists
- **Lakens 2013** — Calculating and Reporting Effect Sizes to Facilitate Cumulative Science: A Practical Primer for t-tests and ANOVAs. *Frontiers in Psychology 4:863*, 2013. [✓ verified; free] <https://doi.org/10.3389/fpsyg.2013.00863>
  - Free effect-size primer with spreadsheet; core reading for the reporting lesson (also serves the t-test/ANOVA lesson)
- **Cumming 2014** — The New Statistics: Why and How. *Psychological Science 25(1):7-29*, 2014. <https://doi.org/10.1177/0956797613504966>
  - The estimation-over-NHST manifesto that changed Psych Science guidelines; paywalled — use Calin-Jageman & Cumming 2019 as the free link
- **Calin-Jageman & Cumming 2019** — The New Statistics for Better Science: Ask How Much, How Uncertain, and What Else Is Known. *The American Statistician 73(sup1):271-280*, 2019. [free] <https://doi.org/10.1080/00031305.2018.1518266>
  - Free modern statement of estimation/new-statistics practice; better wiki link than Cumming 2014
- **Wasserstein, Schirm & Lazar 2019** — Moving to a World Beyond "p < 0.05". *The American Statistician 73(sup1):1-19*, 2019. [free] <https://doi.org/10.1080/00031305.2019.1583913>
  - Free editorial framing the post-p<.05 special issue; also useful in the inference lesson

## Measurement gap-fill + GenAI-era assessment validity

- **Wilson 2023** — Constructing Measures: An Item Response Modeling Approach (2nd ed.). *Routledge*, 2023. [✓ verified] <https://www.routledge.com/Constructing-Measures-An-Item-Response-Modeling-Approach/Wilson/p/book/9781032261683>
  - Anchor for the instrument-development lesson: construct maps + BEAR 4-building-blocks pipeline; cite the 2023 2nd edition, not 2005.
- **BEAR Center (n.d.)** — Berkeley Evaluation & Assessment Research Center — BEAR Assessment System resources. *UC Berkeley (website)*, 2026. [free] <https://bearcenter.berkeley.edu/>
  - Free companion materials to Wilson; legacy ConstructMap software is free, modern BASS is partner-only.
- **Adams & Wieman 2011** — Development and Validation of Instruments to Measure Learning of Expert-Like Thinking. *International Journal of Science Education 33(9):1289-1312*, 2011. [✓ verified] <https://doi.org/10.1080/09500693.2010.512369>
  - Canonical physics/DBER instrument-development process paper; interview-centered, Standards-aligned; the non-life-sci DBER guide requested.
- **Planinic et al. 2019** — Rasch analysis in physics education research: Why measurement matters. *Physical Review Physics Education Research 15:020111*, 2019. [free] <https://doi.org/10.1103/PhysRevPhysEducRes.15.020111>
  - Free DBER-audience Rasch primer; bridges the measurement block to the Rasch/IRT lessons.
- **Boone 2016** — Rasch Analysis for Instrument Development: Why, When, and How?. *CBE—Life Sciences Education 15(4):rm4*, 2016. [free] <https://doi.org/10.1187/cbe.16-04-0148>
  - Second free Rasch how-to primer (life-sci venue but generic); optional.
- **Willis 2005** — Cognitive Interviewing: A Tool for Improving Questionnaire Design. *Sage*, 2005. <https://us.sagepub.com/en-us/nam/cognitive-interviewing/book225856>
  - Deep reference for cognitive interviewing / think-aloud vs verbal probing; cite alongside the short free Willis & Artino piece.
- **Willis & Artino 2013** — What Do Our Respondents Think We're Asking? Using Cognitive Interviewing to Improve Medical Education Surveys. *Journal of Graduate Medical Education 5(3):353-356*, 2013. [priority, unverified; free] <https://doi.org/10.4300/JGME-D-13-00154.1>
  - 4-page free RA-friendly intro to cognitive interviewing; cite in the response-process validity lesson.
- **Pepper et al. 2018** — Think aloud: using cognitive interviewing to validate the PISA assessment of student self-efficacy in mathematics. *International Journal of Research & Method in Education*, 2018. <https://doi.org/10.1080/1743727X.2016.1238891>
  - Worked example of think-aloud/CI validating real assessment items.
- **Bloch & Norman 2012** — Generalizability theory for the perplexed: A practical introduction and guide (AMEE Guide No. 68). *Medical Teacher 34(11):960-992*, 2012. [priority, unverified] <https://doi.org/10.3109/0142159X.2012.703791>
  - The single accessible G-theory pointer requested; raters x tasks x occasions maps onto multi-grader scoring of debugging tasks.
- **Brennan 2001** — Generalizability Theory. *Springer-Verlag*, 2001. <https://doi.org/10.1007/978-1-4757-3456-0>
  - Comprehensive G-theory reference; cite as further reading only.
- **Lai 2022** — Beyond Programming: A Computer-Based Assessment of Computational Thinking Competency. *ACM Transactions on Computing Education 22(2)*, 2022. [priority, unverified; free] <https://doi.org/10.1145/3486598>
  - Cleanest CER-venue Rasch exemplar (Computational Thinking Challenge, Rasch + reliability + convergent validity).
- **Hubwieser & Mühling 2015** — Investigating the Psychometric Structure of Bebras Contest: Towards Measuring Computational Thinking Skills. *LaTiCE 2015 (IEEE)*, 2015. [free] <https://www.edu.sot.tum.de/fileadmin/w00bed/ddi/Publikationen/2015/2015-Hubwieser-Investigating_the_Psychometric_Structure_of_Bebras_Contest.pdf>
  - Early CER Rasch application fitting the Rasch model to Bebras contest data.
- **El-Hamamsy et al. 2022** — The competent Computational Thinking test (cCTt): Development and validation of an unplugged Computational Thinking test for upper primary school. *Journal of Educational Computing Research*, 2022. [free] <https://doi.org/10.1177/07356331221081753>
  - CTT + IRT + CFA validation (n=1519); 2025 follow-up adds DIF/gender-fairness — ties Rasch lesson to the DIF lesson.
- **Finnie-Ansley et al. 2022** — The Robots Are Coming: Exploring the Implications of OpenAI Codex on Introductory Programming. *ACE '22 (Australasian Computing Education)*, 2022. [priority, unverified; free] <https://doi.org/10.1145/3511861.3511863>
  - Anchor for GenAI validity threat: Codex top-quartile on real CS1 exams incl. never-published questions — item secrecy no longer protects instruments.
- **Finnie-Ansley et al. 2023** — My AI Wants to Know if This Will Be on the Exam: Testing OpenAI's Codex on CS2 Programming Exercises. *ACE '23*, 2023. [free] <https://doi.org/10.1145/3576123.3576134>
  - CS2 follow-up: Codex still outscores most students; extends the threat beyond CS1.
- **Savelka et al. 2023a** — Can Generative Pre-trained Transformers (GPT) Pass Assessments in Higher Education Programming Courses?. *ITiCSE '23*, 2023. [free] <https://doi.org/10.1145/3587102.3588792>
  - GPT-3.x on 599 Python course assessments (not quite passing); baseline for the GPT-4 jump.
- **Savelka et al. 2023b** — Thrilled by Your Progress! Large Language Models (GPT-4) No Longer Struggle to Pass Assessments in Higher Education Programming Courses. *ICER '23*, 2023. [free] <https://doi.org/10.1145/3568813.3600142>
  - GPT-4 passes the same courses; MCQs-with-code no longer resistant — cite when discussing unproctored administration.
- **Kortemeyer et al. 2025** — Multilingual performance of a multimodal artificial intelligence system on multisubject physics concept inventories. *Physical Review Physics Education Research 21:020101*, 2025. [free] <https://arxiv.org/abs/2501.06143>
  - GPT-4o beats post-instruction undergrads on screenshot images of PhysPort concept inventories — the concept-inventory-specific validity evidence for a hypothetical DCI.
- **Küchemann et al. 2024** — ChatGPT's quality: Reliability and validity of concept inventory items. *Frontiers in Psychology 15:1426209*, 2024. [free] <https://doi.org/10.3389/fpsyg.2024.1426209>
  - LLM-generated FCI-style items nearly match human item quality — the item-banking/parallel-forms mitigation angle.
- **Prather et al. 2023** — The Robots Are Here: Navigating the Generative AI Revolution in Computing Education. *ITiCSE-WGR '23*, 2023. [free] <https://doi.org/10.1145/3623762.3633499>
  - Standard CER working-group report with explicit assessment-implications guidance; free PDF at juholeinonen.com/assets/pdf/prather2023robots.pdf.
- **Prather et al. 2024** — Beyond the Hype: A Comprehensive Review of Current Trends in Generative AI Research, Teaching Practices, and Tools. *ITiCSE-WGR '24*, 2024. [free] <https://doi.org/10.1145/3689187.3709614>
  - 2024 WG successor; comprehensive GenAI-in-CER review for currency.
- **ITiCSE WG 2025** — The Rest of the Robots: Generative AI in Post-introductory Computing Education. *ITiCSE-WGR '25*, 2025. [free] <https://doi.org/10.1145/3760545.3783970>
  - Newest WG report, extends GenAI assessment concerns past CS1/CS2.
- **MacNeil et al. 2024** — Imagining Computing Education Assessment after Generative AI. *arXiv 2401.04601*, 2024. [free] <https://arxiv.org/abs/2401.04601>
  - Short CS-specific essay on redesigning assessment post-GenAI (incl. ungrading); good discussion-prompt cite.
- **Lodge et al. 2023** — Assessment reform for the age of artificial intelligence. *TEQSA (Australian Government)*, 2023. [free] <https://www.teqsa.gov.au/sites/default/files/2023-09/assessment-reform-age-artificial-intelligence-discussion-paper.pdf>
  - Free higher-ed policy principles (Lodge, Howard, Bearman, Dawson); broader-than-CS assessment-design guidance in the LLM era.
- **Dawson 2021** — Defending Assessment Security in a Digital World: Preventing E-Cheating and Supporting Academic Integrity in Higher Education. *Routledge*, 2021. <https://doi.org/10.4324/9780429324178>
  - Pre-LLM conceptual frame for assessment security vs academic integrity; cite when defining instrument security.
- **Gilardi et al. 2023** — ChatGPT outperforms crowd workers for text-annotation tasks. *PNAS 120(30)*, 2023. [free] <https://doi.org/10.1073/pnas.2305016120>
  - Headline LLM-as-annotator result (beats MTurk by ~25 pts at 1/30 cost); pair with Pangakis as the caution.
- **Pangakis et al. 2023** — Automated Annotation with Generative AI Requires Validation. *arXiv 2306.00176*, 2023. [priority, unverified; free] <https://arxiv.org/abs/2306.00176>
  - The actionable rule for the wiki: LLM labels are task-contingent and must be validated against human gold labels per task.
- **Liu et al. 2025** — Qualitative Coding with GPT-4: Where It Works Better. *Journal of Learning Analytics 12(1):169-185*, 2025. [free] <https://learning-analytics.info/index.php/JLA/article/view/8575>
  - Education-specific coding reliability incl. a debugging-behaviors-in-CS1 dataset — on-theme for the running example; GPT-4 struggles where human IRR is low.
- **Kortemeyer 2024** — Performance of the pre-trained large language model GPT-4 on automated short answer grading. *Discover Artificial Intelligence 4:47*, 2024. [free] <https://doi.org/10.1007/s44163-024-00147-y>
  - Zero-shot GPT-4 short-answer grading benchmark (SciEntsBank/Beetle): decent but below fine-tuned models.
- **Kortemeyer 2023** — Toward AI grading of student problem solutions in introductory physics: A feasibility study. *Physical Review Physics Education Research 19:020163*, 2023. [free] <https://doi.org/10.1103/PhysRevPhysEducRes.19.020163>
  - Free DBER example of LLM-graded open-ended (handwritten) problem solutions.
- **Latif & Zhai 2024** — Fine-tuning ChatGPT for automatic scoring. *Computers and Education: Artificial Intelligence 6:100210*, 2024. [free] <https://doi.org/10.1016/j.caeai.2024.100210>
  - Fine-tuned GPT-3.5 scores science constructed responses accurately; fine-tuning-vs-prompting point for scoring open-ended DCI responses.
- **Smith & Zilles 2024** — Code Generation Based Grading: Evaluating an Auto-grading Mechanism for "Explain-in-Plain-English" Questions. *ITiCSE '24*, 2024. [free] <https://doi.org/10.1145/3649217.3653582>
  - CER-native LLM scoring exemplar (grade explanations by generating code + unit tests); note author is D. H. Smith IV — possibly the user, handle self-citation accordingly.
- **Fu et al. 2025 (review)** — Large Language Model-Powered Automated Assessment: A Systematic Review. *Applied Sciences 15(10):5683 (MDPI)*, 2025. [free] <https://doi.org/10.3390/app15105683>
  - 49-study review; human-LLM agreement ranges QWK 0.99 to ICC 0.45 — the 'it depends, validate locally' citation (author surname unverified beyond venue).

## GenAI research-practice policies and evidence

- **ACM 2023** — ACM Policy on Authorship — Frequently Asked Questions (generative AI provisions). *ACM Publications Policies*, 2023. [priority, unverified; free] <https://www.acm.org/publications/policies/frequently-asked-questions>
  - The binding policy for SIGCSE/ICER/TOCE: AI never an author, disclose all generated content in Acknowledgements, reviewers may not upload submissions to LLMs — cite in every lesson's toolbox footer.
- **Virginia Tech SIRC 2023** — Guidance: Using Artificial Intelligence During Research Activities. *Virginia Tech Division of Scholarly Integrity and Research Compliance*, 2023. [priority, unverified; free] <https://www.research.vt.edu/research-support/forms-guidance/sirc/guidance-using-artificial-intelligence-during-research-activities.html>
  - The lab's own institution's IRB-adjacent rule that pasting participant data into third-party AI tools fails confidentiality provisions — anchor for the privacy ground rules.
- **Walters & Wilder 2023** — Fabrication and errors in the bibliographic citations generated by ChatGPT. *Scientific Reports*, 2023. [priority, unverified; free] <https://doi.org/10.1038/s41598-023-41032-5>
  - Headline fabricated-citation rates (55% GPT-3.5, 18% GPT-4; errors in 24-43% of real ones) — cite wherever the wiki says 'never cite what you haven't read.'
- **Kabir et al. 2024** — Is Stack Overflow Obsolete? An Empirical Study of the Characteristics of ChatGPT Answers to Stack Overflow Questions. *CHI 2024*, 2024. [priority, unverified; free] <https://doi.org/10.1145/3613904.3642596>
  - 52% of ChatGPT programming answers wrong yet preferred for polish and errors overlooked 39% of the time — the core 'plausible is not correct' evidence for a CS audience.
- **McAdoo 2023** — How to cite ChatGPT. *APA Style Blog*, 2023. [priority, unverified; free] <https://apastyle.apa.org/blog/how-to-cite-chatgpt>
  - The APA citation mechanics (company, model, version, date) education-research RAs must follow — doubles as the record-model-and-version reproducibility rule.
- **Dobler et al. 2025** — ChatGPT as a Tool for Biostatisticians: A Tutorial on Applications, Opportunities, and Limitations. *Statistics in Medicine*, 2025. [priority, unverified; free] <https://doi.org/10.1002/sim.70263>
  - The closest methods-paper model for the whole GenAI-toolbox concept: worked statistical use cases with verification strategies and 'calibrated trust' framing.
- **Ruta et al. 2025** — ChatGPT for Univariate Statistics: Validation of AI-Assisted Data Analysis in Healthcare Research. *Journal of Medical Internet Research 27:e63550*, 2025. [priority, unverified; free] <https://www.jmir.org/2025/1/e63550>
  - Empirical basis for the prompting rules: inferential-test accuracy 32.5% with vague prompts vs 92.5% with schema/assumption-specifying prompts; descriptives near-perfect.
- **APA Journals 2023** — APA Journals policy on generative AI: Additional guidance. *American Psychological Association*, 2023. [free] <https://www.apa.org/pubs/journals/resources/publishing-tips/policy-generative-ai>
  - Journal-side rule: disclose AI in Method section, cite the tool, authors must verify AI-provided content — for lessons pointing at APA-published education journals.
- **ICMJE 2025** — Recommendations — Defining the Role of Authors and Contributors (AI-assisted technology provisions). *International Committee of Medical Journal Editors*, 2025. [free] <https://www.icmje.org/recommendations/browse/roles-and-responsibilities/defining-the-role-of-authors-and-contributors.html>
  - The template most journal AI policies copy: no AI authorship, disclose how AI was used (Methods for analysis, Acknowledgments for writing), humans fully responsible.
- **Nature Portfolio 2023** — Artificial Intelligence (AI) — editorial policies. *Nature Portfolio*, 2023. [free] <https://www.nature.com/nature-portfolio/editorial-policies/ai>
  - Notable for the copy-editing exemption (AI polish of your own text needs no declaration) and the AI-image ban — useful when drawing the assistive-vs-generative line.
- **Thorp/Science 2023** — Change to policy on the use of generative AI and large language models. *Science (AAAS editor's blog)*, 2023. [free] <https://www.science.org/content/blog-post/change-policy-use-generative-ai-and-large-language-models>
  - Strictest disclosure bar (full prompt, tool, version in cover letter/acknowledgments) and a case study of policy evolution from outright ban.
- **NSF 2023** — Notice to research community: Use of generative artificial intelligence technology in the NSF merit review process. *U.S. National Science Foundation*, 2023. [free] <https://www.nsf.gov/news/notice-to-the-research-community-on-ai>
  - Federal layer: reviewers barred from uploading proposal content to non-approved GenAI; proposers encouraged to disclose GenAI use and remain responsible for accuracy.
- **NIH 2023** — NOT-OD-23-149: The Use of Generative Artificial Intelligence Technologies is Prohibited for the NIH Peer Review Process. *NIH Guide Notice*, 2023. [free] <https://grants.nih.gov/grants/guide/notice-files/NOT-OD-23-149.html>
  - Cleanest statement of why uploading others' confidential work to an LLM is a confidentiality breach — supports the never-paste-what-you're-reviewing rule.
- **Elsevier 2023** — The use of generative AI and AI-assisted technologies in writing for Elsevier. *Elsevier policy (updated 2025)*, 2023. [free] <https://www.elsevier.com/about/policies-and-standards/the-use-of-generative-ai-and-ai-assisted-technologies-in-writing-for-elsevier>
  - Governs Computers & Education and other Elsevier education venues: language-improvement only, mandatory declaration section before references.
- **Chelli et al. 2024** — Hallucination Rates and Reference Accuracy of ChatGPT and Bard for Systematic Reviews: Comparative Analysis. *Journal of Medical Internet Research 26:e53164*, 2024. [free] <https://www.jmir.org/2024/1/e53164>
  - Second fabrication datapoint (28.6% GPT-4, 91.4% Bard; precision ≤13%) — cite in any lit-review-adjacent toolbox, e.g., the instrument-development lit search.
- **Chhikara 2025** — Mind the Confidence Gap: Overconfidence, Calibration, and Distractor Effects in Large Language Models. *arXiv 2502.11028*, 2025. [free] <https://arxiv.org/abs/2502.11028>
  - Evidence that verbalized confidence is uncalibrated text-pattern output (~88% stated vs ~79% correct) — supports 'the model's confidence is not evidence.'
- **Gallifant et al. 2025** — The TRIPOD-LLM reporting guideline for studies using large language models. *Nature Medicine 31:60-69*, 2025. [free] <https://doi.org/10.1038/s41591-024-03425-5>
  - Reporting checklist (model, version, settings, date, human oversight) — dual use: reproducibility log template, and the standard if the lab studies LLM interventions.
- **Smith et al. 2024** — Ten simple rules for using large language models in science, version 1.0. *PLOS Computational Biology 20(1):e1011767*, 2024. [free] <https://doi.org/10.1371/journal.pcbi.1011767>
  - Open-access practical rules paper, ideal single further-reading link for RAs; grounds the code-as-artifact and human-verification rules.
- **Bockting et al. 2023** — Living guidelines for generative AI — why scientists must oversee its use. *Nature 622:693-696 (Comment)*, 2023. [free] <https://www.nature.com/articles/d41586-023-03266-1>
  - The accountability/transparency/oversight framing to quote in the module's intro to why these rules exist.
- **Prather et al. 2023** — The Robots Are Here: Navigating the Generative AI Revolution in Computing Education. *ITiCSE Working Group Reports*, 2023. [free] <https://doi.org/10.1145/3623762.3633499>
  - The CER community's own canonical GenAI report — signals to RAs that this is a discipline-internal conversation, not an external mandate.
- **Perkel 2023** — Six tips for better coding with ChatGPT. *Nature 618 (Technology Feature)*, 2023. [free] <https://www.nature.com/articles/d41586-023-01833-0>
  - Accessible prompting-for-code advice (specify libraries, give examples, small discrete tasks, always test) for the regression/GLM code toolboxes.
- **SIGCSE TS 2026** — Policies on Generative AI, LLMs, and Related Tools. *SIGCSE Technical Symposium conference site*, 2026. [free] <https://sigcse2026.sigcse.org/info/policies-ai>
  - Venue-level restatement of ACM policy — the link RAs will actually encounter when submitting; shows the policy is live in their community.
- **US Dept of Ed PTAC n.d.** — Data De-identification: An Overview of Basic Terms. *Privacy Technical Assistance Center, studentprivacy.ed.gov*, 2013. [free] <https://studentprivacy.ed.gov/resources/data-de-identification-overview-basic-terms>
  - FERPA's 'reasonable determination' de-identification standard incl. indirect identifiers — the authoritative source behind the de-identification ground rule.
- **FPF 2024** — Vetting Generative AI Tools for Use in Schools. *Future of Privacy Forum*, 2024. [free] <https://fpf.org/wp-content/uploads/2024/10/Ed_AI_legal_compliance.pdf_FInal_OCT24.pdf>
  - FERPA/COPPA legal-compliance vetting pattern for AI tools handling student data — background for the approved-tools rule.
- **UCSF HRPP n.d.** — ChatGPT / Large Language Models (LLM) / Artificial Intelligence (AI). *UCSF Human Research Protection Program*, 2023. [free] <https://irb.ucsf.edu/chatgpt-large-language-models-llm-artificial-intelligence-ai>
  - Model example of explicit IRB-office LLM guidance (tell the IRB about AI tools in the protocol) — useful comparison alongside VT's own page.
- **Virginia Tech DoIT 2025** — Be judicious when sharing university data with publicly available AI tools. *Virginia Tech News (Division of IT notice)*, 2025. [free] <https://news.vt.edu/notices/2025/02/it-ai-best-practices.html>
  - VT's data-classification rule (no personal/sensitive/high-risk data in public AI tools; lowest-risk data that meets the need) — pairs with the approved-tools list at ai.vt.edu/approved-ai-tools.html.
- **Glynn 2024** — Academ-AI: documenting the undisclosed use of generative artificial intelligence in academic publishing. *arXiv 2411.15218*, 2024. [free] <https://arxiv.org/abs/2411.15218>
  - Evidence that undisclosed AI use is being detected and cataloged in published papers — motivates the disclosure and accountability rules.
- **USC Libraries 2024** — Using Generative AI in Research (research guide). *University of Southern California Libraries*, 2024. [free] <https://libguides.usc.edu/generative-AI/scholarship-research>
  - Best general-purpose library guide to link as 'further reading' alongside Purdue's publisher-policy tracker (guides.lib.purdue.edu/c.php?g=1371380&p=10135076).
- **UNESCO 2023** — Guidance for generative AI in education and research. *UNESCO*, 2023. [free] <https://www.unesco.org/en/articles/guidance-generative-ai-education-and-research>
  - The education-research-specific international guidance; fills the gap left by AERA and NCME having no formal GenAI statements.

## Verification table (16 priority citations checked)

- [OK] **Allen, Dorozenko & Roberts 2016** — Difficult Decisions: A Qualitative Exploration of the Statistical Decision Making Process from the Perspectives of Psychology Students and Academics
  - as given — Allen, P. J., Dorozenko, K. P., & Roberts, L. D. (2016). Difficult Decisions: A Qualitative Exploration of the Statistical Decision Making Process from the Perspectives of Psychology Students and Academics. Frontiers in Psychology, 7, Article 188.
  - <https://doi.org/10.3389/fpsyg.2016.00188>
- [OK] **Allen et al. 2019** — An Experimental Evaluation of StatHand: A Free Application to Guide Students' Statistical Decision Making
  - Allen, P. J., Finlay, J., Roberts, L. D., & Baughman, F. D. (2019). An experimental evaluation of StatHand: A free application to guide students' statistical decision making. Scholarship of Teaching and Learning in Psychology, 5(1), 23-36. https://doi.org/10.1037/stl0000132
  - <https://doi.org/10.1037/stl0000132>
- [OK] **Quilici & Mayer 1996** — Role of Examples in How Students Learn to Categorize Statistics Word Problems
  - <https://doi.org/10.1037/0022-0663.88.1.144>
- [OK] **Castro Sotos et al. 2007** — Students' Misconceptions of Statistical Inference: A Review of the Empirical Evidence from Research on Statistics Education
  - <https://doi.org/10.1016/j.edurev.2007.04.001>
- [OK] **Renkl & Atkinson 2003** — Structuring the Transition From Example Study to Problem Solving in Cognitive Skill Acquisition: A Cognitive Load Perspective
  - <https://doi.org/10.1207/S15326985EP3801_3>
- [OK] **Shute 2008** — Focus on Formative Feedback
  - <https://doi.org/10.3102/0034654307313795>
- [OK] **GAISE College Report ASA Revision Committee 2016** — Guidelines for Assessment and Instruction in Statistics Education (GAISE) College Report 2016
  - <https://www.amstat.org/asa/files/pdfs/GAISE/GaiseCollege_Full.pdf>
- [OK] **Gelman, Hill & Vehtari 2020** — Regression and Other Stories
  - Gelman, A., Hill, J., & Vehtari, A. (2020). Regression and Other Stories. Analytical Methods for Social Research. Cambridge University Press. (Citation as given is correct; optionally add the series name and DOI 10.1017/9781139161879.)
  - <https://doi.org/10.1017/9781139161879>
- [OK] **Mize 2019** — Best Practices for Estimating, Interpreting, and Presenting Nonlinear Interaction Effects
  - as given — full form: Mize, Trenton D. 2019. "Best Practices for Estimating, Interpreting, and Presenting Nonlinear Interaction Effects." Sociological Science 6:81-117. DOI: 10.15195/v6.a4
  - <https://doi.org/10.15195/v6.a4>
- [OK] **Arel-Bundock, Greifer & Heiss 2024** — How to Interpret Statistical Models Using marginaleffects for R and Python
  - <https://doi.org/10.18637/jss.v111.i09>
- [OK] **McNeish, Stapleton & Silverman 2017** — On the Unnecessary Ubiquity of Hierarchical Linear Modeling
  - <https://doi.org/10.1037/met0000078>
- [OK] **Theobald 2018** — Students Are Rarely Independent: When, Why, and How to Use Random Effects in Discipline-Based Education Research
  - Theobald, E. (2018). Students Are Rarely Independent: When, Why, and How to Use Random Effects in Discipline-Based Education Research. CBE—Life Sciences Education, 17(3), rm2. (Sole author: Elli Theobald, University of Washington. The claimed citation omitted the author name but is otherwise correct.)
  - <https://doi.org/10.1187/cbe.17-12-0280>
- [OK] **Rosseel 2012** — lavaan: An R Package for Structural Equation Modeling
  - Rosseel, Y. (2012). lavaan: An R Package for Structural Equation Modeling. Journal of Statistical Software, 48(2), 1-36. https://doi.org/10.18637/jss.v048.i02
  - <https://doi.org/10.18637/jss.v048.i02>
- [OK] **Lakens 2013** — Calculating and Reporting Effect Sizes to Facilitate Cumulative Science: A Practical Primer for t-tests and ANOVAs
  - as given (journal renders the title in sentence case: Lakens, D. (2013). Calculating and reporting effect sizes to facilitate cumulative science: a practical primer for t-tests and ANOVAs. Frontiers in Psychology, 4:863. doi: 10.3389/fpsyg.2013.00863)
  - <https://doi.org/10.3389/fpsyg.2013.00863>
- [OK] **Wilson 2023** — Constructing Measures: An Item Response Modeling Approach (2nd ed.)
  - as given — Wilson, M. (2023). Constructing Measures: An Item Response Modeling Approach (2nd ed.). Routledge.
  - <https://doi.org/10.4324/9781003286929>
- [OK] **Adams & Wieman 2011** — Development and Validation of Instruments to Measure Learning of Expert-Like Thinking
  - <https://doi.org/10.1080/09500693.2010.512369>
