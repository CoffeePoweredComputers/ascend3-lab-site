/**
 * genai-toolbox — data for <GenAiToolbox id="…" /> and <GenAiGroundRules />.
 *
 * One entry per lesson that gets a toolbox (not every lesson does — concept
 * lessons where outsourcing the thinking defeats the point get none, on
 * purpose). Prompts are ALWAYS schema-only: they describe the data's columns
 * and design, never contain rows, and never contain anything a participant
 * produced. All prompts are centralized here so they can be reviewed and
 * updated in one place as models change.
 *
 * Verify checklists render as static glyphs — no state, no persistence.
 */

export interface GenAiRule {
  kind: 'do' | 'dont';
  text: string;
  citeIds: string[];
}

export interface GenAiToolboxEntry {
  /** One line: what the LLM is for HERE. */
  task: string;
  /** Tool-tier note; defaults to the VT-approved-tier line if omitted. */
  tool?: string;
  /** Full example prompt, shown in a <details> block. */
  prompt: string;
  /** Why the prompt is shaped this way. */
  promptNotes?: string[];
  /** "Verify before trusting" checklist. */
  verify: string[];
  /** Known failure mode, warning-tinted strip. */
  failure: string;
  failureCiteIds?: string[];
}

export const DEFAULT_TOOL =
  'Use the VT-approved tier (Copilot with your VT sign-in) for anything that touches study data; this prompt is schema-only, so any tier is fine.';

export const groundRules: GenAiRule[] = [
  {
    kind: 'dont',
    text: 'Never paste anything a participant gave you — transcripts, survey free-text, code submissions, grades, emails — into a public AI tool. Pasting is disclosure to a third party and can void your protocol’s confidentiality provisions.',
    citeIds: ['vt-sirc-2023'],
  },
  {
    kind: 'dont',
    text: '“I deleted the names” is not de-identified. Indirect identifiers, small cells, and free text count (“the one woman in the 8am section” is identifiable; code style is an identifier). Use an identifier checklist before anything leaves your machine.',
    citeIds: ['ptac-2013'],
  },
  {
    kind: 'dont',
    text: 'Never cite anything an LLM told you about until you have retrieved and read it. Measured fabrication rates for LLM-generated references are high, and fakes pair real author names with invented titles — eyeballing fails.',
    citeIds: ['walters-wilder-2023', 'chelli-etal-2024'],
  },
  {
    kind: 'dont',
    text: 'Do not treat the model’s confidence as evidence. Models are most fluent exactly when wrong; verification is external — a rerun, a second method, a retrieved source — never the model’s self-report.',
    citeIds: ['chhikara-2025', 'dobler-etal-2025'],
  },
  {
    kind: 'dont',
    text: 'Never upload a manuscript, proposal, or anything you are reviewing. ACM, NSF, and NIH all prohibit putting others’ confidential work into third-party AI tools.',
    citeIds: ['acm-genai-2023', 'nsf-2023', 'nih-2023'],
  },
  {
    kind: 'do',
    text: 'Use the university-approved tool tier (at VT: Microsoft Copilot signed in with your VT account) for anything touching research or student data, and use the lowest-risk data that meets the need.',
    citeIds: ['vt-doit-2025', 'vt-sirc-2023'],
  },
  {
    kind: 'do',
    text: 'Prompt with the schema, not the data: variables, design, constraints. Ask for assumptions, diagnostics, effect sizes, and “what could be wrong” — not reassurance. Prompt specificity measurably transforms accuracy.',
    citeIds: ['ruta-etal-2025', 'perkel-2023'],
  },
  {
    kind: 'do',
    text: 'The code is the artifact of record. The chat is not the analysis; every reported number must regenerate from a script in the repo, run by you. A large share of LLM programming answers contain errors, and readers overlook most of them.',
    citeIds: ['kabir-etal-2024', 'smith-etal-2024'],
  },
  {
    kind: 'do',
    text: 'Keep a four-line AI-use log per use: date · tool + model/version · what it was used for · how the output was verified. This is what disclosure policies ask you to be able to reconstruct.',
    citeIds: ['apa-genai-2023', 'mcadoo-2023'],
  },
  {
    kind: 'do',
    text: 'Disclose per venue and own everything you submit. ACM: Acknowledgements statement; APA journals: Method section + citation. AI is never an author anywhere, accountability stays with you — and undisclosed use is being actively detected.',
    citeIds: ['acm-genai-2023', 'apa-genai-2023', 'glynn-2024'],
  },
];

export const genaiToolbox: Record<string, GenAiToolboxEntry> = {
  'desc-code': {
    task: 'Draft the summary-and-plot code for debugging-study.csv — the LLM writes code, you run everything.',
    prompt: `You are helping with descriptive statistics in R. Write code only; do not
compute any statistics yourself.

Data: debugging-study.csv - one row per debugging-exercise attempt.
Columns: student (id), section ("sprint"/"control"), pre, post (0-20 test
scores, repeated on every row for a student), se1-se6 (1-5 Likert),
exercise (E01-E12), fixed (0/1), minutes (time to fix, right-skewed,
capped at 30). 462 rows, 40 students. No missing values.

Write an R script (tidyverse) that:
1. Prints n distinct students per section, and rows per student.
2. Summarizes minutes overall and by section: mean, SD, median, IQR.
3. Plots a histogram of minutes faceted by section, and a boxplot.
4. Collapses to one row per student before summarizing pre/post
   (explain in a comment why summarizing pre on 462 rows would be wrong).
Comment what each block does and what I should look for.`,
    promptNotes: [
      'Schema, never data — the CSV stays on your machine.',
      'The one-row-per-student instruction bakes the unit-of-analysis lesson into the code.',
    ],
    verify: [
      'Run the script yourself; compare two or three numbers against a spreadsheet spot-check.',
      'Check the student-level collapse actually happened (40 rows, not 462) before reading pre/post summaries.',
      'Confirm the mean/median gap for minutes matches the skew you can see in the histogram.',
    ],
    failure:
      'Chat-computed means and SDs are wrong often enough to matter — arithmetic is not a strength. Code that you run is; prose answers with numbers in them are not.',
    failureCiteIds: ['kabir-etal-2024'],
  },

  'disclosure-draft': {
    task: 'Draft the venue-specific AI-use disclosure statement from your AI-use log.',
    tool: 'Any tier — the prompt contains your own log lines, no participant data.',
    prompt: `Here are the AI-use log entries for a paper I am submitting (each line:
date, tool+model, what it was used for, how verified):

[paste your log lines]

Target venue: [ACM SIGCSE / an APA journal]. Draft the disclosure this
venue requires - for ACM, an Acknowledgements-section statement; for APA,
a Method-section sentence plus the reference-list citation format. Use
only what is in the log; do not soften or omit any use.`,
    promptNotes: [
      'The log is the source of truth — the model formats it, it does not decide what to disclose.',
    ],
    verify: [
      'Check the drafted statement against the venue’s current policy page yourself — policies have changed year to year.',
      'Every log entry appears; nothing got summarized away.',
      'For lit-search uses: every reference the LLM ever suggested was retrieved and read before it entered the bibliography.',
    ],
    failure:
      'Undisclosed or under-disclosed use is being actively detected and catalogued in published papers. The failure is not the tool use — it is the missing sentence about it.',
    failureCiteIds: ['glynn-2024', 'walters-wilder-2023'],
  },

  'ttest-assumptions': {
    task: 'Draft two-group comparison code that must include assumption checks and an effect size.',
    prompt: `You are helping with a two-group comparison in R. Write code only.

Data: one row per student (n = 40): section ("sprint"/"control"), and
gain = post - pre on a 0-20 debugging test.

Write an R script that:
1. Plots the gain distributions by section (not just tests them).
2. Runs Welch's t-test on gain by section.
3. Reports Cohen's d with a 95% CI (effectsize package).
4. Runs a Wilcoxon rank-sum as a sensitivity analysis and says in a
   comment what different question it answers.
5. States in comments which assumptions matter here and which do not
   (and why a Shapiro-Wilk gate is not part of the workflow).`,
    promptNotes: [
      'Asking for the assumption discussion in comments turns hidden model choices into checkable claims.',
      'The Ruta pattern: specific prompts with the design spelled out are what make LLM statistical setups accurate.',
    ],
    verify: [
      'Run it; confirm the t-test is Welch (var.equal = FALSE) — silently pooled variances are a classic slip.',
      'Check d’s sign matches the group order you intended.',
      'The Wilcoxon comment should say “stochastic dominance / shift,” not “the same test without normality.”',
    ],
    failure:
      'Basic prompts get inferential setups wrong roughly two-thirds of the time; the specificity in this prompt is the fix, not the model’s goodwill.',
    failureCiteIds: ['ruta-etal-2025'],
  },

  'lm-whats-wrong': {
    task: 'Ask "what could be wrong with this analysis?" — the adversarial-review use, not the write-my-code use.',
    prompt: `I fit this model in R on course data and I want you to attack it, not
reassure me.

Design: two intact CS 2 sections (not randomized), n = 119 students; SPRINT
debugging intervention in one section. Model: lm(post ~ pre + section),
post and pre are 0-20 test scores.

List, in order of how much they could change the conclusion:
1. Threats this design cannot rule out.
2. Diagnostics I should run on this specific model, and what pattern
   would worry you in each.
3. What the section coefficient does and does not estimate here.
Do not suggest a different dataset; work with what exists.`,
    promptNotes: [
      'Formula and design only — no data rows.',
      '“Attack it” framing counteracts the model’s agreement bias; ordering by impact forces prioritization.',
    ],
    verify: [
      'Cross-check the threat list against the lesson’s caveats (confounding with instructor, self-selection, ceiling).',
      'Actually run the diagnostics it names; do not let the list substitute for the plots.',
      'Anything it claims about "controlling for" pre-test: check against Lord’s paradox in the lesson.',
    ],
    failure:
      'The model agrees confidently with whatever you fit — its default register is reassurance, and confidence is not evidence.',
    failureCiteIds: ['chhikara-2025'],
  },

  'logistic-translate': {
    task: 'Turn your verified logistic output into a sentence an instructor understands — the LLM translates your numbers; it never computes them.',
    tool: 'Any tier — the prompt contains only your model summary, no participant data.',
    prompt: `You are helping translate a statistical result into plain language for a
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
  intervention 82% (computed by me with marginal effects - use these,
  do not derive your own)

Draft 3 candidate sentences that:
1. Lead with the predicted-probability difference in percentage points,
   not the odds ratio.
2. Convey uncertainty without the words "odds," "significant," or
   "confidence interval."
3. Make clear this is one study in one course.
Then, for each sentence, list what it leaves out, so I can judge the
tradeoff myself.`,
    promptNotes: [
      'All numbers come from your verified run; predicted probabilities are pre-computed by you because OR→probability conversion is precisely where LLMs slip.',
      'The causal-language constraint is tied to the stated design — for observational data, say so and ban causal verbs.',
      'Options plus omissions, not one authoritative sentence — the judgment stays human.',
    ],
    verify: [
      'Every number in each draft matches your R output digit-for-digit; models “helpfully” round and convert.',
      'Conflation check: nothing renders “OR 1.86” as “86% more likely to pass.” The only probability statements are your 71%/82% figures.',
      'Causal-scope check: verbs match the design (an RCT supports “led to”; strike it for anything observational).',
      'Uncertainty survived translation — the clean sentence still carries “the study can’t pin down the exact size” or equivalent.',
      'Read-aloud test with a non-stats colleague or the PI — the audience check no model can do.',
      'If the sentence lands in a paper: this is generated text → venue disclosure + AI-use log entry.',
    ],
    failure:
      'Odds-ratio-to-probability conflation and fluent overclaiming: the most readable draft is often the one that quietly upgraded your effect size or dropped the uncertainty. Readers prefer polished wrong answers and miss the errors — so the polish is the risk.',
    failureCiteIds: ['kabir-etal-2024', 'chhikara-2025'],
  },

  'glm-errors': {
    task: 'Paste the convergence warning or error message — never the data — and ask what it means and what to check.',
    prompt: `R gave me this warning fitting a count model and I want to understand it
before changing anything:

[paste the exact warning/error text and the model call, nothing else]

Explain: (1) what this warning means mechanically, (2) the two or three
most common causes for a model like this, (3) what to CHECK for each
cause (not what to change yet), (4) which "fixes" would silence the
warning without addressing the cause - so I can avoid them.`,
    promptNotes: [
      'Scoped-to-strengths use: error-message explanation is where LLMs are genuinely reliable.',
      'Asking for checks before fixes prevents the silence-the-warning anti-pattern.',
    ],
    verify: [
      'Run the checks it suggests; only then change the model.',
      'If it recommends switching family (e.g., Poisson → negative binomial), confirm the overdispersion check actually supports that.',
    ],
    failure:
      'Suggested “fixes” that make the warning disappear without addressing the cause — swallowed non-convergence is worse than the warning.',
    failureCiteIds: ['kabir-etal-2024'],
  },

  'mlm-syntax': {
    task: 'Scaffold lme4 / geepack syntax from a design description — ask for options and tradeoffs, not one answer.',
    prompt: `You are helping with clustered data in R. Write code and comparisons only;
do not pick a final model for me.

Design: 462 rows, one per debugging-exercise attempt. 40 students (the
clusters; treatment assigned per student), each attempting the same 12
exercises; outcome fixed (0/1). Columns: student, section, exercise,
fixed.

Show, with syntax and a two-sentence tradeoff each:
1. Mixed-effects logistic: glmer, random intercept for student, exercise
   as fixed effects; note what adding (1|exercise) crossed would change.
2. GEE logistic: geeglm, exchangeable working correlation, and where the
   small-sample sandwich correction comes from at 40 clusters.
3. The aggregate-then-t-test fallback.
For 1 vs 2, state which estimand each reports (subject-specific vs
population-average) and how the written conclusion would differ.`,
    promptNotes: [
      'The estimand question is the point — syntax is cheap, knowing which OR you estimated is not.',
    ],
    verify: [
      'Check every argument against the installed docs (?glmer, ?geeglm) — API drift is real.',
      'Confirm the two ORs differ in the direction the lesson predicts (marginal closer to 1).',
      'Cluster count sanity check: the GEE output should show 40 clusters, not 462.',
    ],
    failure:
      'Plausible-but-wrong random-effects structures — models that converge and mean something other than what the comment claims. Advanced uses need enough background to check the output.',
    failureCiteIds: ['dobler-etal-2025'],
  },

  'sem-lavaan': {
    task: 'Draft lavaan syntax from your drawn path model — require the df arithmetic in comments so you can hand-check identification.',
    prompt: `You are helping specify a structural equation model in lavaan (R). Write
syntax only; do not invent fit thresholds.

Model, from my path diagram: latent DebugSelfEfficacy measured by six 1-5
items (se1-se6); structural paths: section (0/1) -> strategy use
(observed) -> post score; DebugSelfEfficacy -> post score; section ->
post score (direct).

Write the lavaan model string and fitting call, with comments that:
1. Count free parameters and degrees of freedom by hand.
2. State the estimator you chose for ordinal indicators and why (WLSMV
   vs ML), as a checkable claim.
3. Mark which path carries the indirect effect and how to request its
   bootstrap CI.`,
    promptNotes: [
      'The by-hand df count is the identification tripwire — if the model’s arithmetic is wrong, you catch it before interpreting anything.',
    ],
    verify: [
      'Check the df in lavaan’s output against the comment’s hand count.',
      'Confirm the estimator actually used (summary output) matches the claimed one — silent defaults differ by lavaan version.',
      'Every operator in the model string exists in the lavaan docs — invented operators parse as something else or error.',
    ],
    failure:
      'Invented lavaan operators or arguments, and silently non-default estimators — the model runs, fits, and means the wrong thing. Hand-check df before trusting any fit index.',
    failureCiteIds: ['kabir-etal-2024'],
  },

  'alpha-omega': {
    task: 'Draft the reliability code for dci-pilot.csv — then cross-check two packages against each other.',
    prompt: `You are helping with reliability analysis in R. Write code only.

Data: dci-pilot.csv - 150 rows, columns id plus i01-i20 (0/1 item scores),
no missing values.

Write an R script that:
1. Drops id; computes Cronbach's alpha and McDonald's omega (psych
   package), with a comment on what different assumptions each makes.
2. Prints the corrected item-total correlation for every item, sorted.
3. Flags any item whose removal raises alpha, with a comment warning
   about alpha-chasing (why removal-by-alpha is a trap).
4. Cross-checks omega against a one-factor CFA loading-based omega
   (lavaan), and comments on why they should approximately agree.`,
    promptNotes: [
      'The two-package cross-check is the verification, built into the script itself.',
    ],
    verify: [
      'Run it; the two omega estimates should be close — investigate if not.',
      'The item flagged with a negative item-total correlation should be the mis-keyed one the lesson planted; if the script doesn’t surface it, the script is wrong.',
      'Do not act on “alpha if item deleted” — that is the lesson’s point, not a to-do list.',
    ],
    failure:
      'LLMs will happily “compute” alpha in prose or misstate tau-equivalence. Reliability numbers come from your console, never from the chat.',
    failureCiteIds: ['kabir-etal-2024'],
  },

  'mirt-calibration': {
    task: 'Draft the R calibration script for the DCI pilot — the LLM writes code, you run and check everything.',
    tool: 'Any tier is fine — this prompt contains the schema only, never the data.',
    prompt: `You are helping with item response theory calibration in R. Do not compute
any statistics yourself - write R code only.

Data: dci-pilot.csv - pilot responses to a 20-item Debugging Concept
Inventory. N = 150 CS 2 students. Columns: id (arbitrary participant
code), i01-i20 (item scores, 0 = incorrect, 1 = correct). No missing
values. The file contains no identifiers beyond the arbitrary code and no
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
5. Runs item fit (S-X2) and flags items by the cutoff you use - state
   the cutoff in a comment and where it comes from.
6. Checks local dependence (Q3 or LD-X2) and flags pairs; state the
   cutoff and its source.
7. Plots the test information function and all ICCs.
8. Ends with sessionInfo().

Comment each step with what it does and what I should look at in the
output. Where N = 150 is a limitation (especially for 2PL slope SEs),
say so in a comment instead of silently working around it.`,
    promptNotes: [
      'Schema, never data — the CSV stays on your machine.',
      '“Write code, don’t compute” forces verify-by-execution.',
      'Pins package + minimum version; asks for cutoffs with sources so hallucinated conventions surface as checkable claims.',
      'Asks for limitations in comments — “what could be wrong,” not “is this right.”',
    ],
    verify: [
      'Run the script top-to-bottom in a fresh R session. Only your console output counts; anything the chat claims the output “will show” is noise.',
      'Check every function/argument against the installed docs (?itemfit, ?residuals) — mirt’s argument names have changed across versions and LLMs mix eras.',
      'Cross-check with a second package: refit the Rasch model in eRm or TAM and correlate item difficulties with mirt’s b’s; sanity-check that b ordering roughly matches classical p-values.',
      'Read the SEs yourself: N = 150 is thin for 2PL slopes. Do not accept the model’s verbal reassurance about sample size.',
      'Retrieve the source for every cutoff the script cites (Q3, S-X2 thresholds) before adopting it — cutoffs and their citations are a known fabrication zone.',
      'Log it: date, tool + model/version, “drafted mirt calibration script,” “verified by rerun + eRm cross-check.”',
    ],
    failure:
      'Plausible-but-nonexistent function arguments and stale mirt API calls that error — or worse, run with different semantics than the comment claims. Second-order failure: fitting the 2PL without ever checking unidimensionality. Models pick the right analysis reliably; execution details are where they break.',
    failureCiteIds: ['kabir-etal-2024', 'ruta-etal-2025'],
  },

  'dif-code': {
    task: 'Draft DIF screening code — and run the live fabrication exercise in this lesson before trusting any reference it offers.',
    prompt: `You are helping with differential item functioning analysis in R (difR
package). Write code only.

Data: item response matrix (0/1, 20 items) plus a binary grouping
variable; roughly 200 respondents per group (NOT the 150-person pilot -
this is the planned multi-site sample).

Write an R script that:
1. Runs Mantel-Haenszel DIF with purification, reporting effect-size
   classifications (ETS A/B/C), with a comment on what purification does.
2. Runs logistic-regression DIF distinguishing uniform from non-uniform,
   with the R-squared effect-size gate stated as a checkable claim.
3. Comments on what a flagged item does and does NOT mean (DIF is not
   yet bias).`,
    promptNotes: [
      'The sample-size line prevents the model from cheerfully writing code for data that cannot support the analysis.',
    ],
    verify: [
      'Check the ETS classification thresholds it used against a retrieved source — cutoffs are a fabrication zone.',
      'Confirm purification is actually iterating (difR reports it), not just mentioned in a comment.',
      'The lesson’s exercise: ask the LLM for five DIF references, then try to retrieve each — the hit rate is the point.',
    ],
    failure:
      'Fabricated references with real authors and invented titles — DIF methodology citations are exactly the kind of plausible-sounding source LLMs invent. Retrieve before citing, every time.',
    failureCiteIds: ['walters-wilder-2023', 'chelli-etal-2024'],
  },

  'item-drafting': {
    task: 'Draft parallel-form items for the DCI — every generated item goes through expert review and think-alouds; the human panel is non-negotiable.',
    prompt: `You are helping draft assessment items for a Debugging Concept Inventory
(intro CS, language-light pseudocode). These drafts will go to an expert
panel and student think-alouds; none will be used as-is.

Target misconception, from our interview data: [one-sentence misconception
description, e.g., "students believe a program that compiles cannot
contain logic errors"].

Draft 3 candidate multiple-choice items that:
1. Present a short pseudocode fragment (max 8 lines) with one seeded bug.
2. Have exactly one keyed answer and three distractors, where each
   distractor maps to a NAMED misconception (state the mapping).
3. Avoid construct-irrelevant difficulty: no language-specific syntax,
   no trick wording, no memory-dependent APIs.
For each item, state which part of the construct definition it covers,
so the panel can check blueprint coverage.`,
    promptNotes: [
      'The misconception comes from your qualitative findings — the LLM instantiates it, it does not invent the construct.',
      'Distractor-to-misconception mapping makes each draft item checkable against the blueprint.',
    ],
    verify: [
      'Expert panel reviews every item for content validity — LLM-drafted items approach human quality but do not equal it.',
      'Think-alouds with students before piloting: response-process evidence is a validity strand no generator provides.',
      'Check the keyed answer is actually correct by tracing the pseudocode yourself.',
      'Blueprint check: coverage claims verified against the construct map, not taken from the item text.',
    ],
    failure:
      'Two failures live here. Item-level: plausible items whose keyed answer is wrong or whose distractors are accidentally defensible. Instrument-level: models solve CS1-style items above post-instruction undergrads, so any unproctored DCI administration can no longer separate student ability from AI assistance — a threat to the validity argument itself, not just to one item.',
    failureCiteIds: ['kuchemann-etal-2024', 'finnie-ansley-etal-2022', 'savelka-etal-2023'],
  },
};
