/**
 * quant-scenarios — data for <ScenarioWalkthrough /> (quantitative module).
 *
 * Each Scenario is a fixed-vignette walkthrough of a "which analysis and why"
 * decision. Unlike DecisionTree (which routes the reader's own study), the
 * vignette determines the correct path, so the widget is a linear step spine
 * with a forced choice at each step — wrong picks open feedback, then everyone
 * continues on the same spine. That is what lets every option teach.
 *
 * Authoring rules (follow these when adding a scenario):
 *  - The vignette carries complete design info (who, N, assignment, measures,
 *    timing, the actual question); `facts` pins the load-bearing chips.
 *  - Step 1 never offers test names — design questions first, tests later.
 *  - Exactly ONE option per step has verdict 'best'; any number 'defensible'.
 *  - Every 'trap' instantiates a documented misconception and MUST carry
 *    `whenRight` ("this would be the right call if…") — the boundary condition
 *    that turns a wrong answer into a schema edge.
 *  - 'defensible' feedback states the tradeoff, never bare permission.
 *  - Feedback is 2–4 sentences and names the structural cue honored/ignored.
 *  - 3–5 steps, 3–4 options; one walkthrough per lesson.
 *
 * Design evidence (not in references.json — component-level sources): an RCT
 * found an interactive one-question-at-a-time decision aid beat textbook and
 * paper flowcharts on selection accuracy (Allen, Finlay, Roberts & Baughman,
 * 2019, StatHand); students otherwise select by surface keywords (Allen,
 * Dorozenko & Roberts, 2016); per-option elaborated feedback per Shute (2008);
 * surface-vs-structure contrast per Quilici & Mayer (1996).
 */

export type Verdict = 'best' | 'defensible' | 'trap';

export interface ScenarioOption {
  /** Button text. On early steps this is a claim about the design, never a bare test name. */
  label: string;
  verdict: Verdict;
  /** 2–4 sentences; names the structural cue this option honors or ignores. */
  feedback: string;
  /** "This would be the right call if…" — required when verdict === 'trap'. */
  whenRight?: string;
}

export interface ScenarioStep {
  id: string;
  question: string;
  options: ScenarioOption[];
  /** Optional one-liner shown once the step is resolved. */
  note?: string;
}

export interface Scenario {
  id: string;
  title: string;
  vignette: string;
  /** 3–6 short chips pinned above every step. */
  facts: string[];
  steps: ScenarioStep[];
  verdict: {
    recommendation: string;
    /** Ready-to-adapt sentence(s); [bracketed] placeholders for numbers. */
    reportingSentence: string;
    caveats: string[];
    alternatives?: { label: string; body: string }[];
    lessons: { label: string; href: string }[];
    /** Resolved via getReference() and rendered as citation links. */
    citeIds?: string[];
  };
}

/* ── WT1: Two sections, pre and post ─────────────────────────────────── */

export const sectionsPrepost: Scenario = {
  id: 'sections-prepost',
  title: 'Two sections, pre and post',
  vignette:
    'The lab is piloting SPRINT, a weekly debugging-exercise intervention, in CS 2. Section 1 (n = 58) gets SPRINT; Section 2 (n = 61) gets business-as-usual instruction. Every student takes the same 20-item debugging test in week 1 (pre) and week 13 (post); the score is number correct, 0–20. Students picked their own sections at registration, and the sections have different instructors. The lab head asks: "Did SPRINT improve debugging scores more than regular instruction did?"',
  facts: [
    'Outcome: 0–20 test score',
    'Pre + post, same test',
    'Two intact sections, n = 58 / 61',
    'Self-selected, different instructors',
    'Question: improved MORE than control',
  ],
  steps: [
    {
      id: 'outcome',
      question: 'Before naming any test: what is the outcome variable here, and how should you treat it?',
      options: [
        {
          label: 'The post-test score (0–20), treated as approximately continuous',
          verdict: 'best',
          feedback:
            'Right read. A sum of 20 items has many possible values and behaves close enough to interval for means and regressions at this sample size — this is standard practice for course-level comparisons. Note what you did: you matched the outcome to the question (students’ overall ability), not to the raw data format (20 binary items).',
        },
        {
          label: 'Twenty separate binary items — run chi-square or logistic regression item by item',
          verdict: 'trap',
          feedback:
            'Item-by-item analysis answers a measurement question — which items are hard, whether items behave — not the course-level question of whether SPRINT students improved more. It also buys you 20 tests’ worth of multiple-comparison trouble for a question that needs one answer. The structural cue missed: the research question is about students, so the student-level total is the outcome.',
          whenRight:
            'If the lab were evaluating the instrument — item difficulty, discrimination, whether the test measures one thing — item-level analysis is exactly right. That is the IRT walkthrough’s territory.',
        },
        {
          label: 'Ordinal only — sums of test items aren’t truly interval, so only rank-based tests are allowed',
          verdict: 'trap',
          feedback:
            'This is measurement-level folklore applied as a hard rule. Whether means of sum scores are trustworthy depends on test length, sample size, and floor/ceiling behavior — not on a categorical prohibition. A 20-item score with n ≈ 119 supports means and regression comfortably; a purist reading would also forbid the means and SDs every published table reports.',
          whenRight:
            'For a single 3-point Likert item, a tiny sample, or a score slammed against its floor or ceiling, rank-based or ordinal models genuinely earn their keep.',
        },
      ],
      note: 'Outcome settled: one roughly-continuous score per student per timepoint. Next: how those scores relate.',
    },
    {
      id: 'structure',
      question:
        'There are four columns of scores: Sec 1 pre, Sec 1 post, Sec 2 pre, Sec 2 post. How do they actually relate?',
      options: [
        {
          label: 'Four independent groups of scores — compare them with a 2×2 between-subjects ANOVA',
          verdict: 'trap',
          feedback:
            'Pre and post from the same student are strongly correlated — the same person appears in two columns. Treating the four columns as independent both double-counts every student and throws away the precision that pairing buys you. The cue missed: repeated measurement of the same unit is never "another group."',
          whenRight:
            'If pre and post came from different cohorts of students (say, last year’s class vs this year’s), all four cells really would be independent groups.',
        },
        {
          label: 'Each student contributes a linked (pre, post) pair; the two sections are independent groups of students',
          verdict: 'best',
          feedback:
            'Right read, and it’s the whole design in one sentence: pairing within students, independence between sections — a mixed pre/post-with-control design. Every defensible analysis of this study is some way of respecting both halves of that sentence.',
        },
        {
          label: 'One group measured twice — pool both sections and test whether scores rose from pre to post',
          verdict: 'trap',
          feedback:
            'Pooling erases the comparison the question is about. Scores rising from week 1 to week 13 could be practice effects, maturation, or test familiarity — the control section exists precisely to absorb those. The cue missed: the question is comparative ("more than regular instruction"), so the analysis must compare.',
          whenRight:
            'In a single-group feasibility pilot with no control, a pooled pre/post look is all you have — reported honestly as pre-experimental, with no causal language.',
        },
      ],
    },
    {
      id: 'analysis',
      question: 'Which analysis answers "did SPRINT students improve MORE than business-as-usual students"?',
      options: [
        {
          label: 'Paired t-test on Section 1’s pre vs post scores',
          verdict: 'trap',
          feedback:
            'This shows Section 1 improved — it cannot show they improved more than the control. A significant within-group gain in the treatment arm is one of the most common wrong moves in published pre/post studies: practice, maturation, and re-testing all inflate it, and the control section you’re ignoring is the fix. The cue missed: the counterfactual lives in Section 2.',
          whenRight: 'Only if no control group existed — and then the write-up must say "scores rose," not "the intervention worked."',
        },
        {
          label: 'Independent-samples t-test on post-test scores only',
          verdict: 'defensible',
          feedback:
            'Defensible under randomization, where post-only is unbiased, just noisier. Here students chose their sections, so baseline differences are likely — ignoring the pre-test both wastes your single strongest precision covariate and lets a head start masquerade as a treatment effect. Tradeoff: simplest possible analysis, weakest use of the design.',
        },
        {
          label: 'Independent-samples t-test on gain scores (post − pre)',
          verdict: 'defensible',
          feedback:
            'A solid, honest choice: it directly answers "which section changed more," uses the pairing, and is easy to report. Tradeoffs: slightly less power than covariate adjustment when pre and post are imperfectly correlated, and no room to adjust for anything else. Worth reporting even when it’s not the headline analysis.',
        },
        {
          label: 'Linear regression: post ~ pre + section (ANCOVA)',
          verdict: 'best',
          feedback:
            'Right read — with one caveat coming. Adjusting for pre-test gives the most precise estimate of the section difference, and notice the machinery: this "ANCOVA" is just a linear regression with a dummy variable, the same model the regression lesson builds — the independent t-test in the previous option is the special case with the covariate deleted. The tests-vs-models wall is thinner than the names suggest.',
        },
      ],
      note: 'With intact (non-randomized) groups, gain scores and ANCOVA can genuinely disagree — Lord’s paradox. The verdict card returns to this.',
    },
    {
      id: 'assumptions',
      question:
        'Section 1’s post-test distribution looks left-skewed, and a Shapiro–Wilk test on it gives p = .03. What now?',
      options: [
        {
          label: 'Switch to Mann–Whitney to be safe',
          verdict: 'trap',
          feedback:
            'This is the two-stage ritual — test normality, then switch — and it’s discredited: it distorts error rates, checks the wrong thing (the assumption concerns residuals, not each group’s raw scores), and at n ≈ 119 the central limit theorem already protects the mean comparison. It also quietly changes the question: Mann–Whitney tests stochastic dominance, not "difference in adjusted means."',
          whenRight:
            'Chosen a priori for a small sample with heavy tails, where a shift-in-location question is genuinely what you want, rank-based or robust methods are respectable.',
        },
        {
          label: 'Plot residuals from the regression; look for outliers and ceiling effects; proceed unless something structural appears',
          verdict: 'best',
          feedback:
            'Right read. Left skew in a 0–20 post-test usually means students bunched near the top — a ceiling, which is a measurement and interpretation problem (gains are compressed for strong students), not a switch-tests trigger. Assumptions are checked by looking at the model’s residuals and thinking about mechanism, not by running significance tests on marginal distributions.',
        },
        {
          label: 'Nothing — t-tests and regressions are always robust',
          verdict: 'trap',
          feedback:
            'Robustness is real but bounded: severe skew with small unequal groups, variance differences correlated with group size, or a hard ceiling can all bite. The habit to build is look, then decide — plot residuals, use Welch/robust standard errors by default — not never look.',
          whenRight:
            'Closer to true for large balanced samples with mild non-normality — which is an argument for looking once, not for a policy of never looking.',
        },
      ],
    },
  ],
  verdict: {
    recommendation:
      'Fit the linear regression post ~ pre + section (ANCOVA) with Welch-style/robust standard errors, and report the gain-score t-test alongside it as a sensitivity analysis. Because the sections are intact, self-selected groups, agreement between the two is reassuring and disagreement is itself a finding to discuss (Lord’s paradox).',
    reportingSentence:
      'Adjusting for pre-test score, students in the SPRINT section scored on average [b] points higher (out of 20) on the post-test than business-as-usual students (b = [b], 95% CI [[lo], [hi]], p = [p], d ≈ [d]). A gain-score comparison agreed (mean gain [g1] vs [g2] points).',
    caveats: [
      'Sections were not randomized: SPRINT is confounded with instructor, meeting time, and self-selection. Write "the SPRINT section improved more," never "SPRINT caused the improvement."',
      'Two sections means two clusters — too few to model section statistically; this is a design limitation the analysis cannot repair, only the write-up can acknowledge (the clustered-data lesson explains why).',
      'Lord’s paradox: with intact groups, covariate adjustment and gain scores answer subtly different questions; report both.',
      'A post-test ceiling compresses gains for strong students and can bias the comparison; report the score distribution, not just means.',
      'The comparison is only as good as the score: check the test’s reliability (measurement block).',
    ],
    alternatives: [
      {
        label: 'Why not repeated-measures ANOVA?',
        body:
          'A 2 (time) × 2 (section) RM-ANOVA’s interaction test is algebraically the gain-score t-test. It isn’t wrong — it’s the same analysis wearing heavier clothing, and it hides rather than shows what’s being compared.',
      },
      {
        label: 'Why not a multilevel model?',
        body:
          'MLM needs enough clusters to estimate between-cluster variance; with exactly two sections, section and treatment are the same column of the data. Nesting matters here as a limitation, not as a modeling opportunity.',
      },
    ],
    lessons: [
      { label: 'ANOVA & categorical (host lesson)', href: '/wiki/quantitative/anova-and-categorical' },
      { label: 'Linear regression — the same model, formalized', href: '/wiki/quantitative/linear-regression' },
      { label: 'Clustered data — why 2 clusters can’t be modeled', href: '/wiki/quantitative/clustered-data-mlm-gee' },
      { label: 'Reliability — is the score trustworthy?', href: '/wiki/quantitative/reliability-and-item-analysis' },
    ],
    citeIds: ['lord-1967', 'vanbreukelen-2006'],
  },
};

/* ── WT2: 462 attempts, 40 students ──────────────────────────────────── */

export const attemptsGee: Scenario = {
  id: 'attempts-gee',
  title: '462 attempts, 40 students',
  vignette:
    'The lab’s debugging-practice platform logged a study: 40 students (21 with SPRINT hint scaffolds, 19 control) each attempted the same 12 debugging exercises over four weeks. For every attempt the log records one outcome — bug fixed within 10 minutes, yes or no. Some students skipped exercises, so there are 462 attempts, not 480. The lab head asks: "Does the scaffold raise students’ chances of fixing bugs, on average across students — and phrase it in plain English for the paper." (This is exactly the shipped debugging-study.csv.)',
  facts: [
    'Outcome: fixed / not fixed per attempt',
    '462 attempts from 40 students',
    'Same 12 exercises for everyone',
    'Treatment assigned per student',
    'Some exercises skipped',
    'Question: average effect across students',
  ],
  steps: [
    {
      id: 'unit',
      question: 'You have 462 rows of fixed/not-fixed. What is the independent unit here?',
      options: [
        {
          label: 'The attempt — 462 independent observations',
          verdict: 'trap',
          feedback:
            'Attempts by the same student share that student’s skill, persistence, and prior exposure — they are correlated, not independent. Treating them as independent inflates your effective sample from 40 students to 462 rows, so standard errors come out far too small and p-values far too confident. The cue missed: the treatment was assigned per student, so independence lives at the student level.',
          whenRight: 'If every row came from a different person — one attempt per student — rows really would be independent.',
        },
        {
          label: 'The student — attempts within a student are correlated',
          verdict: 'defensible',
          feedback:
            'The right primary answer: student is the cluster that matters most, because that’s where treatment was assigned. One refinement available (see the next option): students aren’t the only thing rows share.',
        },
        {
          label: 'Both students and exercises — rows share a student’s skill AND an exercise’s difficulty',
          verdict: 'best',
          feedback:
            'The sharpest read. The same 12 exercises repeat across all students, so responses are cross-classified: correlated within student and within exercise. Minimum viable handling: cluster on student and put exercise in the model (12 fixed effects, or a crossed random effect). This "both" answer is the kind experts give and flowcharts never offer.',
        },
      ],
    },
    {
      id: 'family',
      question: 'Which analysis family fits a yes/no outcome with this structure?',
      options: [
        {
          label: 'Aggregate first: each student’s proportion fixed, then a two-sample t-test (21 vs 19)',
          verdict: 'defensible',
          feedback:
            'Honest about the unit of independence, simple, and robust — a fine sanity check, and in a balanced complete design often perfectly publishable. Tradeoffs here: a student with 6 attempts counts the same as one with 12, exercise difficulty can’t be adjusted for, and skipping makes the per-student denominators uneven. Keep it as the companion analysis, not the headline.',
        },
        {
          label: 'Ordinary logistic regression on all 462 attempts with a treatment dummy',
          verdict: 'trap',
          feedback:
            'Right family, wrong independence assumption. The point estimate will be roughly sensible, but the standard errors, CI, and p-value are computed as if you had 462 independent students — they will be too narrow. The cue missed: choosing the binomial family fixed the outcome type; it did nothing about the dependence structure. Those are separate decisions.',
          whenRight: 'With one attempt per student, plain logistic regression is exactly the tool — see the logistic-regression lesson.',
        },
        {
          label: 'A binomial model that accounts for students: GEE or mixed-effects (multilevel) logistic',
          verdict: 'best',
          feedback:
            'Right read: keep the attempt-level rows (so exercise effects stay available) and let the model carry the clustering. Which of the two — GEE or mixed logistic — is not a technicality; they estimate different quantities, and that’s the next step.',
        },
        {
          label: 'Linear regression on the 0/1 outcome with cluster-robust standard errors (linear probability model)',
          verdict: 'defensible',
          feedback:
            'More respectable than its reputation: with cluster-robust SEs it handles the dependence, and its coefficient is a risk difference ("9 percentage points more attempts fixed"), which is the plainest English available. Tradeoffs: predicted probabilities can leave [0,1], and reviewers in CER venues will expect a logistic family. Defensible; not the convention.',
        },
      ],
    },
    {
      id: 'model',
      question: 'GEE vs mixed-effects logistic: what’s the real difference, and which matches the lab head’s question?',
      options: [
        {
          label: 'They’re interchangeable — use whichever converges',
          verdict: 'trap',
          feedback:
            'For logistic models they estimate different quantities (non-collapsibility of the odds ratio): GEE gives a population-average OR — "compare the scaffolded group’s rates to the control group’s" — while a mixed model gives a subject-specific OR — "multiply a given student’s odds," typically further from 1. Choosing between them is choosing what claim your paper makes, not a software preference.',
          whenRight: 'For linear (identity-link) models the two targets coincide, and the choice really is closer to convenience.',
        },
        {
          label: 'GEE: logistic family, exchangeable working correlation, robust standard errors — the population-average effect',
          verdict: 'best',
          feedback:
            'Matches the question as asked: "on average across students" is a marginal, group-level claim, which is exactly GEE’s estimand. The exchangeable working correlation is a guess the robust (sandwich) SEs forgive if wrong. One flag: 40 clusters is at the lower edge for sandwich SEs — use a small-sample correction (e.g., Mancl–DeRouen) and say so.',
        },
        {
          label: 'Mixed-effects logistic: random intercept per student, plus exercise effects',
          verdict: 'defensible',
          feedback:
            'Right when you want student-level variation, crossed random effects for exercises, or per-student predictions — and its missing-data behavior is more forgiving (valid under MAR, while standard GEE leans on the stronger MCAR). Since students did skip exercises, that’s a live tradeoff, and a good reason to run this as a sensitivity analysis. The cost: the OR becomes "for a given student," which is not the sentence the lab head asked for.',
        },
      ],
    },
    {
      id: 'report',
      question: 'The GEE returns OR = 1.9, 95% CI [1.2, 3.0] for scaffold vs control. Which sentence goes in the paper?',
      options: [
        {
          label: '"Scaffolded students were 1.9 times more likely to fix a bug."',
          verdict: 'trap',
          feedback:
            '"Times more likely" is risk-ratio language, and an odds ratio is not a risk ratio. With outcomes this common (over half of attempts fixed), OR = 1.9 corresponds to being only about 1.3 times as likely — the OR always looks more impressive. This is one of the most frequent misreports in published quantitative work.',
          whenRight:
            'If the outcome were rare (a few percent), OR ≈ RR and this phrasing would be approximately harmless — still better to say "odds."',
        },
        {
          label: '"For a given student, the scaffold multiplied their odds of fixing a bug by 1.9."',
          verdict: 'trap',
          feedback:
            'That’s subject-specific phrasing — the mixed-model estimand. Your GEE estimate is a statement about group rates, not about change within any individual student. Matching sentence to estimand is precisely why the previous step mattered.',
          whenRight: 'This sentence belongs to the mixed-effects logistic OR — if you’d fit that model, this is how you’d phrase it.',
        },
        {
          label:
            '"The odds of fixing an exercise were 1.9 times higher in the scaffolded group (OR = 1.9, 95% CI [1.2, 3.0]); in terms of predicted probabilities, scaffolded students fixed about 68% of exercises versus 53% for control."',
          verdict: 'best',
          feedback:
            'Right read: odds language kept technically accurate, then translated into predicted probabilities — which is the plain-English move readers and reviewers actually want. Percentages of attempts fixed is the sentence the lab head can put in the abstract; the OR and CI are the receipts.',
        },
      ],
    },
  ],
  verdict: {
    recommendation:
      'GEE logistic regression: scaffold condition + exercise fixed effects, exchangeable working correlation, robust standard errors with a small-sample correction (≈40 clusters). Report the per-student aggregate t-test as a sanity check, and a mixed-effects logistic (random intercept per student, crossed exercise effect) as a sensitivity analysis — especially because skipped exercises make GEE’s missing-data assumption the weakest link.',
    reportingSentence:
      'Scaffolded students fixed a higher proportion of debugging exercises than control students (predicted [p1]% vs [p0]%; GEE population-average OR = [or], 95% CI [[lo], [hi]], robust SEs corrected for [k] clusters), adjusting for exercise.',
    caveats: [
      '40 clusters is the floor for sandwich standard errors; use and report a small-sample correction.',
      'Skipped exercises: standard GEE assumes skipping is unrelated to outcomes (≈MCAR); if weaker students skipped harder exercises, the mixed-model sensitivity analysis matters.',
      'Do not compare this OR numerically with a mixed-model OR from another paper — marginal and conditional ORs differ by construction.',
      '"Fixed within 10 minutes" dichotomizes a duration; the cutoff discards information, and a time-to-fix analysis is the richer follow-up if the cutoff was arbitrary.',
      'Treatment was assigned per student, not randomized within exercises — group differences in persistence or prior experience are uncontrolled unless measured and modeled.',
    ],
    alternatives: [
      {
        label: 'Why not chi-square on the 462 attempts?',
        body:
          'Same independence violation as plain logistic regression, with less flexibility — no adjustment for exercises, no CI on an effect scale you can report.',
      },
      {
        label: 'Why not model each exercise separately?',
        body:
          'Twelve underpowered tests and no overall answer; the whole point of GEE/mixed models is to pool evidence across exercises while respecting structure.',
      },
    ],
    lessons: [
      { label: 'Clustered data: MLM + GEE (host lesson)', href: '/wiki/quantitative/clustered-data-mlm-gee' },
      { label: 'Logistic regression — the family, without clustering', href: '/wiki/quantitative/logistic-regression' },
      { label: 'GLMs — links and families', href: '/wiki/quantitative/glms-beyond-binary' },
      { label: 'Comparing two groups — the aggregate t-test companion', href: '/wiki/quantitative/comparing-two-groups' },
    ],
    citeIds: ['mancl-derouen-2001', 'hubbard-etal-2010'],
  },
};

/* ── WT3: "Run IRT on the DCI" ───────────────────────────────────────── */

export const dciIrt: Scenario = {
  id: 'dci-irt',
  title: '“Run IRT on the DCI”',
  vignette:
    'The lab drafted a 20-item Debugging Concept Inventory (DCI), all items scored right/wrong. It was piloted in one CS 2 course: N = 150 usable response sets (the shipped dci-pilot.csv). The lab head says: "Run IRT so we can put the DCI’s psychometrics in the paper." You have this one sample, this one course, and a deadline. What do you actually run — CTT item analysis, Rasch, or a 2PL?',
  facts: [
    '20 dichotomous items',
    'N = 150, one course, one institution',
    'Instrument is new (pilot)',
    'Request: “run IRT”',
    'Deliverable: psychometric evidence for a paper',
  ],
  steps: [
    {
      id: 'question',
      question: 'Before any model: what question would “running IRT” actually answer here?',
      options: [
        {
          label: 'Whether students learned debugging this semester',
          verdict: 'trap',
          feedback:
            'There’s no comparison and no second timepoint in this data — nothing here can support a learning claim. Measurement models describe how an instrument behaves, not whether an intervention worked. The cue missed: instrument evaluation and outcome evaluation are different questions needing different designs.',
          whenRight:
            'With pre/post administrations and a comparison group, learning becomes answerable — that’s the two-sections walkthrough, not this one.',
        },
        {
          label:
            'Whether the DCI’s items and scores behave well enough to support claims: item difficulty, discrimination, reliability, dimensionality',
          verdict: 'best',
          feedback:
            'Right read: this is a measurement question. IRT is one family of tools for answering it; classical test theory is another; they overlap heavily on a 20-item pilot. The deliverable is validity evidence — an argument that scores mean what you claim — not a p-value.',
        },
        {
          label: 'IRT is the modern replacement for CTT, so fitting an IRT model is what makes the DCI “validated”',
          verdict: 'trap',
          feedback:
            'No single analysis validates an instrument. Validity is an argument assembled from several evidence types — content coverage, response processes, internal structure, relations to other variables — and an IRT calibration speaks only to internal structure. CTT is not obsolete: for flagging broken items in a pilot it is faster, more transparent, and assumption-lighter.',
          whenRight:
            'Never, as stated — but the kernel of truth is that IRT adds real value (sample-independent-ish item parameters, item information curves) once the sample can support it.',
        },
      ],
    },
    {
      id: 'screening',
      question: 'First analysis to run on the 150 × 20 response matrix?',
      options: [
        {
          label: 'Shapiro–Wilk on total scores, to check normality before IRT',
          verdict: 'trap',
          feedback:
            'A normality ritual transplanted from t-test land. IRT models the item responses, not the total score, and no IRT decision hinges on a Shapiro–Wilk p-value. The checks that matter here are item-level and structural — difficulty, discrimination, dimensionality.',
          whenRight: 'Essentially never as a gate; eyeballing the total-score distribution for floor/ceiling is still worth ten seconds.',
        },
        {
          label:
            'CTT item analysis plus a dimensionality check: per-item proportion correct, corrected item–total (point-biserial) correlations, alpha/omega, and a parallel-analysis or factor check that one dimension dominates',
          verdict: 'best',
          feedback:
            'Right read. This screening is cheap and catches catastrophes before any latent model: items nearly everyone or no one gets right, negative point-biserials (often a mis-keyed answer), and multidimensionality — which every IRT candidate you’re considering assumes away. Latent models fit garbage items without complaint; CTT screening is how you notice.',
        },
        {
          label: 'Fit the 2PL immediately — it estimates difficulty and discrimination in one shot anyway',
          verdict: 'trap',
          feedback:
            'The 2PL will converge and produce parameters even for broken items and a multidimensional test — it hides key errors behind strange estimates rather than flagging them. And it presumes the unidimensionality you haven’t checked. Screen first, model second.',
          whenRight: 'After screening, on an adequate sample, going straight to a 2PL is a perfectly normal workflow.',
        },
      ],
    },
    {
      id: 'model',
      question: 'Given N = 150, which is the most ambitious item model you can defensibly report?',
      options: [
        {
          label: 'CTT only — 150 is too small for any IRT',
          verdict: 'defensible',
          feedback:
            'A CTT-only pilot paragraph (difficulties, discriminations, alpha/omega, distractor notes) is respectable and many published concept-inventory pilots stop there. But it’s more conservative than necessary: Rasch item calibrations are usably stable from roughly 100–250 respondents, so you can go one step further with honest standard errors.',
        },
        {
          label: 'Rasch (1PL): one difficulty parameter per item',
          verdict: 'best',
          feedback:
            'Right read for this N. One parameter per item keeps the demand on 150 respondents modest; you get item difficulties on a common logit scale with honest SEs, item-fit statistics that flag misfitting items for revision, and — because the raw score is sufficient in the Rasch model — results that speak directly to the total score instructors will actually use.',
        },
        {
          label: '2PL: difficulty plus per-item discrimination',
          verdict: 'trap',
          feedback:
            'The extra 20 discrimination parameters are where N = 150 falls down: common working guidance asks for several hundred respondents (≈500 is the usual citation) before 2PL discriminations stabilize. At this N their standard errors are wide and their rank order is noisy — and revising items based on noisy a-parameters churns the instrument on evidence that won’t replicate.',
          whenRight:
            'On the planned multi-site administration with several hundred responses — or now, as a clearly-labeled exploratory Bayesian fit with informative priors.',
        },
        {
          label: '3PL — these are multiple-choice items, so the guessing parameter is required',
          verdict: 'trap',
          feedback:
            'Guessing is real, but the c-parameter is notoriously the hardest to estimate — it needs on the order of a thousand respondents and often misbehaves even then. At N = 150 it will not yield meaningful estimates. The cue missed: parameters must be paid for with information, and low-ability responses to hard items (where guessing shows) are exactly where a small sample is thinnest.',
          whenRight:
            'Large-scale administrations (assessment programs, multi-institution concept inventories) — or handle guessing by design: distractor analysis now, fixed/priored c later.',
        },
      ],
    },
    {
      id: 'dif',
      question: 'The lab head adds: “and check DIF by gender and by prior programming experience while you’re at it.”',
      options: [
        {
          label: 'Sure — run Mantel–Haenszel or logistic-regression DIF on the 150',
          verdict: 'trap',
          feedback:
            'Do the arithmetic first: 150 splits into subgroups of perhaps 40 and 110 — far below the roughly 200-per-group working guidance for stable DIF detection. At this size you’ll get noisy flags in both directions: items accused of DIF that aren’t, and real DIF missed. Running it isn’t wrong; believing it is.',
          whenRight:
            'With a couple hundred respondents per subgroup, MH or logistic DIF is exactly the standard move — the DIF lesson covers both.',
        },
        {
          label: 'Defer confirmatory DIF to the larger sample; at N = 150, report at most an exploratory screen, labeled as such',
          verdict: 'best',
          feedback:
            'Right read: claims sized to the data. Put DIF in the instrument’s development plan with the target subgroup sizes stated — that sentence in the limitations section is itself good psychometric practice, and reviewers reward it.',
        },
        {
          label: 'DIF isn’t needed — the total score’s reliability is already high',
          verdict: 'trap',
          feedback:
            'Reliability and invariance are different rungs of the evidence ladder: a test can be highly internally consistent and still function differently across groups (same total score, different meaning). High alpha answers "is the score consistent?", not "is it fair?".',
          whenRight: 'Never — but the kernel is real: reliability evidence is a prerequisite worth reporting before invariance evidence.',
        },
      ],
    },
  ],
  verdict: {
    recommendation:
      'A staged plan. Now, for the paper: CTT screening (difficulty, corrected point-biserials, alpha/omega, distractor analysis) plus a dimensionality check, then a Rasch calibration with item-fit statistics and a Wright map as the headline psychometric evidence. Explicitly deferred, in the limitations/future-work: 2PL discrimination estimates and confirmatory DIF, both waiting on the multi-institution sample.',
    reportingSentence:
      'Item difficulties (proportion correct) ranged [.xx–.xx]; corrected item–total correlations ranged [.xx–.xx], with [k] items below .20 flagged for revision. Internal consistency was α = [.xx] (ω = [.xx]). A Rasch model showed acceptable fit for [n] of 20 items (infit MSQ [.xx–.xx]); item difficulties spanned [−x.x to +x.x] logits and were well targeted to the sample. The pilot sample (N = 150) supports Rasch calibration but not stable 2PL discrimination estimates or confirmatory DIF analyses; these are planned for the multi-institution administration.',
    caveats: [
      'One course at one institution: item calibrations may not travel; say "in this population" and mean it.',
      'N = 150 usable response sets — report how many were dropped and why; nonresponse can be informative.',
      'Unidimensionality is a precondition, not a finding to skip: report the check, not just the model.',
      'Internal structure is one strand of validity; the paper still needs content evidence (expert review / blueprint) and ideally response-process evidence (think-alouds) — see the instruments lesson.',
      'Alpha assumes tau-equivalence it rarely gets; report omega alongside it.',
    ],
    alternatives: [
      {
        label: 'Why not just report alpha and move on?',
        body:
          'Alpha says the items co-vary; it says nothing about which items are broken, how difficulty spans ability, or whether the score separates students — the item-level evidence is what makes a pilot paragraph convincing.',
      },
      {
        label: 'Rasch vs 2PL in one sentence?',
        body:
          'Rasch fixes all discriminations equal and treats misfit as a flaw in the item to fix; the 2PL estimates discriminations and weights items accordingly — a philosophical difference (measurement model vs statistical model) that stops being academic only when N can actually estimate the extra parameters.',
      },
    ],
    lessons: [
      { label: 'IRT fundamentals (host lesson)', href: '/wiki/quantitative/irt-fundamentals' },
      { label: 'Reliability & item analysis — the screening toolkit', href: '/wiki/quantitative/reliability-and-item-analysis' },
      { label: 'Validity — the evidence argument', href: '/wiki/quantitative/validity' },
      { label: 'DIF & fairness — what’s being deferred and why', href: '/wiki/quantitative/dif-and-fairness' },
      { label: 'Instruments in practice — the staged plan in full', href: '/wiki/quantitative/instruments-in-practice' },
    ],
    citeIds: ['linacre-1994', 'deayala-2022', 'aera-apa-ncme-2014'],
  },
};
