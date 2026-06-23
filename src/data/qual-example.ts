/**
 * The running example for the Qualitative Analysis module.
 *
 * A small (fictional, illustrative) corpus of intro-CS student interview
 * excerpts about a debugging / help-seeking experience. Authored ONCE here and
 * reused across lessons so the same data visibly travels from raw notes →
 * codes → codebook → merged codebook → categories → themes, and is analyzed
 * two ways (codebook/coding-reliability and reflexive thematic analysis).
 *
 * Each participant's excerpt is coded for MORE THAN ONE theme, and each theme
 * draws on MORE THAN ONE participant — themes are patterns *across* the corpus,
 * not per-person summaries. The coverage is deliberately many-to-many:
 *   Help-Seeking Anxiety        ← P3, P7
 *   Improvised Debugging        ← P3, P7, P9
 *   Error Messages as Barriers  ← P7, P9
 *
 * Shapes match the wiki component props (CodedTranscript, Codebook,
 * CodeConsolidation, CodebookMerge, ThemeTree).
 */

type Segment = {
  text: string;
  code?: string;
  codeType?: 'in vivo' | 'descriptive';
  memo?: string;
  rollsUpTo?: string;
};
type Turn = { speaker: string; segments: Segment[] };

/* ── Stage 1: familiarization — raw text with analytic jottings (not codes yet) ── */
export const familiarizationTurns: Turn[] = [
  {
    speaker: 'Researcher',
    segments: [{ text: 'Walk me through the last time you got really stuck on an assignment.' }],
  },
  {
    speaker: 'P3',
    segments: [
      { text: "So it was this linked-list thing and I kept getting a null pointer exception. " },
      {
        text: 'I sat there for probably an hour just staring at it',
        code: 'jotting: long delay before asking',
        memo: 'A whole hour stuck before seeking help. Why wait? Note the time emphasis.',
      },
      { text: ' before I said anything. Honestly ' },
      {
        text: "I didn't want the TA to think I was dumb",
        code: 'jotting: worried about TA judgment',
        memo: 'Affective — social risk of asking. This feels important; watch for it elsewhere.',
      },
      { text: ' for not getting something that seemed basic. Before that I ' },
      {
        text: 'just kept rewriting the same few lines hoping it would work',
        code: 'jotting: changing code without a plan',
        memo: 'Not just a help-seeking story — there is a debugging style here too. Note both.',
      },
      { text: '. When I finally went up, ' },
      {
        text: 'the TA fixed it in like two minutes',
        code: 'jotting: quick fix once asked',
        memo: 'The cost of waiting was huge relative to the fix. Relief, but also "I feel silly".',
      },
      { text: ' and I felt kind of stupid for waiting so long.' },
    ],
  },
];

/* ── Stage 2: initial / first-cycle coding (descriptive + in vivo) ──
   Each participant is coded for codes that roll up to MORE THAN ONE theme. */
export const initialCodingTurns: Turn[] = [
  {
    speaker: 'P3',
    segments: [
      { text: 'It was a linked-list thing, a null pointer exception. ' },
      {
        text: 'I sat there for probably an hour before I asked',
        code: 'help-seeking delay',
        codeType: 'descriptive',
        memo: 'Delays help despite being stuck. The same delay shows up in P7.',
        rollsUpTo: 'Help-Seeking Anxiety',
      },
      { text: '. Honestly ' },
      {
        text: "didn't want the TA to think I was dumb",
        code: '"think I was dumb"',
        codeType: 'in vivo',
        memo: "Participant's own words. Fear of negative evaluation as the barrier to asking.",
        rollsUpTo: 'Help-Seeking Anxiety',
      },
      { text: ' for missing something basic. Before that I ' },
      {
        text: 'just kept rewriting the same few lines hoping it would work',
        code: 'trial-and-error debugging',
        codeType: 'descriptive',
        memo: 'No hypothesis — changing code and hoping. Same improvised tactic as P7 and P9: this excerpt is not only about help-seeking.',
        rollsUpTo: 'Improvised Debugging',
      },
      { text: '. When I finally asked, ' },
      {
        text: 'the TA fixed it in two minutes',
        code: 'relief after help',
        codeType: 'descriptive',
        memo: 'Large gap between cost of waiting and cost of asking.',
        rollsUpTo: 'Help-Seeking Anxiety',
      },
      { text: ' and I felt silly for waiting.' },
    ],
  },
  {
    speaker: 'P7',
    segments: [
      { text: "For debugging I don't really have a system. " },
      {
        text: 'I just kept changing things and re-running it',
        code: 'trial-and-error debugging',
        codeType: 'descriptive',
        memo: 'Unsystematic strategy — no stated hypothesis. Matches P3.',
        rollsUpTo: 'Improvised Debugging',
      },
      { text: ' until something worked — ' },
      {
        text: "I wasn't testing a hypothesis or anything",
        code: 'no systematic method',
        codeType: 'in vivo',
        memo: 'Names the absence of method directly.',
        rollsUpTo: 'Improvised Debugging',
      },
      { text: '. The compiler kept throwing this ' },
      {
        text: "type-mismatch error I couldn't make sense of",
        code: 'cryptic error messages',
        codeType: 'descriptive',
        memo: 'Tool output opaque to the student — the same barrier P9 describes. P7 spans debugging AND error messages.',
        rollsUpTo: 'Error Messages as Barriers',
      },
      { text: ', and I ' },
      {
        text: 'thought about asking the TA but didn\'t want to bug them again',
        code: 'help-seeking delay',
        codeType: 'descriptive',
        memo: 'Reluctance to ask recurs here, not just in P3 — help-seeking is a cross-cutting theme.',
        rollsUpTo: 'Help-Seeking Anxiety',
      },
      { text: ', so I just ' },
      {
        text: 'googled the exact error message',
        code: 'googling the error',
        codeType: 'descriptive',
        memo: 'Outsourcing the diagnosis to search/Stack Overflow.',
        rollsUpTo: 'Improvised Debugging',
      },
      { text: ' and pasted in whatever came up.' },
    ],
  },
  {
    speaker: 'P9',
    segments: [
      { text: 'The thing that gets me is the error messages. ' },
      {
        text: '"segmentation fault" and that means nothing to me',
        code: 'cryptic error messages',
        codeType: 'descriptive',
        memo: 'Tooling output is opaque to a novice — a trigger for being stuck. Recurs in P7.',
        rollsUpTo: 'Error Messages as Barriers',
      },
      { text: " — it doesn't say where or why. " },
      {
        text: 'I tried reading the stack trace but it was all addresses',
        code: 'reading the stack trace',
        codeType: 'descriptive',
        memo: 'Even the diagnostic is unreadable to them.',
        rollsUpTo: 'Error Messages as Barriers',
      },
      { text: '. So I ' },
      {
        text: 'added print statements all over to find where it died',
        code: 'print-statement debugging',
        codeType: 'descriptive',
        memo: 'Self-taught tooling in absence of a debugger — improvised debugging shows up in P9 too.',
        rollsUpTo: 'Improvised Debugging',
      },
      { text: ', just guessing really. After a while ' },
      {
        text: 'I just gave up for the night',
        code: 'disengagement',
        codeType: 'descriptive',
        memo: 'Outcome of the barrier. Possible link to affect.',
        rollsUpTo: 'Error Messages as Barriers',
      },
      { text: ', and ' },
      {
        text: 'I kind of dreaded opening it again the next day',
        code: 'dreading the next bug',
        codeType: 'descriptive',
        memo: 'The barrier has an emotional aftertaste that carries forward.',
        rollsUpTo: 'Error Messages as Barriers',
      },
      { text: '.' },
    ],
  },
];

/* ── Stage 2 (Path B): the SAME data coded reflexively (latent, interpretive) ──
   Same multi-theme spans as Path A, recoded for underlying meaning. */
export const reflexiveCodingTurns: Turn[] = [
  {
    speaker: 'P3',
    segments: [
      { text: 'It was a linked-list thing, a null pointer exception. ' },
      {
        text: 'I sat there for probably an hour before I asked',
        code: 'asking as last resort',
        codeType: 'descriptive',
        memo: 'Latent reading: help is a last resort, not a first move. Asking carries a cost.',
        rollsUpTo: 'Asking for help as social risk',
      },
      { text: '. Honestly ' },
      {
        text: "didn't want the TA to think I was dumb",
        code: 'managing how I am seen',
        codeType: 'descriptive',
        memo: 'Beyond fear — actively managing an identity as a competent student before an authority.',
        rollsUpTo: 'Asking for help as social risk',
      },
      { text: ' for missing something basic. Before that I ' },
      {
        text: 'just kept rewriting the same few lines hoping it would work',
        code: 'acting without a model',
        codeType: 'descriptive',
        memo: 'Latent: acting on the code without a mental model of it — agency is low. Same span, a debugging reading.',
        rollsUpTo: 'Debugging as lonely trial-and-error',
      },
      { text: '.' },
    ],
  },
  {
    speaker: 'P7',
    segments: [
      { text: 'I never really felt in control of it. ' },
      {
        text: 'I just kept changing things and re-running it',
        code: 'guessing in the dark',
        codeType: 'descriptive',
        memo: 'Agency is low — acting on the code without a model of it.',
        rollsUpTo: 'Debugging as lonely trial-and-error',
      },
      { text: '. The compiler kept throwing an ' },
      {
        text: "error I couldn't make sense of",
        code: 'tool that talks past me',
        codeType: 'descriptive',
        memo: 'Latent: the message positions the student as not its intended audience — it withholds rather than guides.',
        rollsUpTo: 'The error message as gatekeeper',
      },
      { text: ', and I ' },
      {
        text: "didn't want to bug the TA again",
        code: 'asking as last resort',
        codeType: 'descriptive',
        memo: 'Help withheld to avoid being a burden — managing standing. Social risk recurs here, not only in P3.',
        rollsUpTo: 'Asking for help as social risk',
      },
      { text: ', so I ' },
      {
        text: 'googled it and pasted in whatever came up',
        code: 'outsourcing understanding',
        codeType: 'descriptive',
        memo: 'Understanding is borrowed from strangers online, not built.',
        rollsUpTo: 'Debugging as lonely trial-and-error',
      },
      { text: '.' },
    ],
  },
  {
    speaker: 'P9',
    segments: [
      { text: 'The error said ' },
      {
        text: '"segmentation fault" and that means nothing to me',
        code: 'tool that talks past me',
        codeType: 'descriptive',
        memo: 'Latent: the message withholds rather than guides — the novice is not its audience.',
        rollsUpTo: 'The error message as gatekeeper',
      },
      { text: ', so I ' },
      {
        text: 'added prints everywhere just to see where it broke',
        code: 'guessing in the dark',
        codeType: 'descriptive',
        memo: 'Probing blindly for a foothold — the lonely improvised struggle shows up in P9 too.',
        rollsUpTo: 'Debugging as lonely trial-and-error',
      },
      { text: ', and eventually I just ' },
      {
        text: 'gave up for the night',
        code: 'shut out',
        codeType: 'descriptive',
        memo: 'The tool ends the session, not the student. Sense of being shut out.',
        rollsUpTo: 'The error message as gatekeeper',
      },
      { text: '.' },
    ],
  },
];

/* ── Stage 3: consolidating redundant first-cycle codes ── */
export const consolidationGroups = [
  {
    consolidated: 'fear of negative evaluation',
    raw: ['"think I was dumb"', 'embarrassed to ask', 'fear TA judgment', 'felt stupid'],
    rationale:
      'Four initial codes all name the same affective barrier — worry about how others judge one\'s competence. Merge into one well-defined code.',
  },
  {
    consolidated: 'improvised debugging strategy',
    raw: ['trial-and-error debugging', 'print-statement debugging', 'random changes'],
    rationale: 'Different tactics, one underlying idea: self-taught, unsystematic strategies for finding bugs.',
  },
];

/* ── Stage 4: the codebook (Path A) ── */
export const codebookEntries = [
  {
    code: 'help-seeking delay',
    definition: 'Waiting a substantial time while stuck before seeking help from a TA, peer, or instructor.',
    example: 'I sat there for like an hour before I asked',
    include: 'There is an explicit gap between getting stuck and asking.',
    exclude: 'Do not apply to delays caused purely by external factors (e.g., office hours closed).',
  },
  {
    code: 'fear of negative evaluation',
    definition: 'Reluctance to act (esp. to ask for help) driven by worry about being judged incompetent.',
    example: "didn't want the TA to think I was dumb",
    include: 'Affective concern about others’ judgment of one’s ability.',
    exclude: 'Do not apply to neutral statements of not knowing something (that is "low knowledge").',
  },
  {
    code: 'improvised debugging strategy',
    definition: 'Self-taught, unsystematic tactics for locating a bug (trial-and-error, scattered print statements).',
    example: 'changing things and re-running it until something worked',
    include: 'Strategy described with no clear hypothesis or systematic method.',
    exclude: 'Do not apply to deliberate, hypothesis-driven debugging.',
  },
  {
    code: 'cryptic error messages',
    definition: 'Tool output (errors, stack traces) experienced as opaque or meaningless to the student.',
    example: '"segmentation fault" and that means nothing to me',
    include: 'Student names the message as unclear or unhelpful.',
    exclude: 'Do not apply when the student understood and acted on the message.',
  },
];

/* ── Stage 5: two coders' independent assignments, for the merge/IRR demo ── */
export const mergeSegments = [
  { text: 'before I asked', coderA: 'help-seeking delay', coderB: 'help-seeking delay', agreed: 'help-seeking delay' },
  { text: 'think I was dumb', coderA: 'fear of negative evaluation', coderB: 'low confidence', agreed: 'fear of negative evaluation' },
  { text: 'print statements all over', coderA: 'improvised debugging strategy', coderB: 'improvised debugging strategy', agreed: 'improvised debugging strategy' },
  { text: 'means nothing to me', coderA: 'cryptic error messages', coderB: 'cryptic error messages', agreed: 'cryptic error messages' },
  { text: 'gave up for the night', coderA: 'disengagement', coderB: 'cryptic error messages', agreed: 'disengagement' },
];

/* ── Stage 6 (Path A): codebook-derived themes ──
   Each theme's codes are contributed by more than one participant. */
export const codebookThemes = [
  {
    name: 'Help-Seeking Anxiety',
    definition:
      'Students delay or avoid seeking help because asking feels like exposing incompetence. Seen in P3 (the linked-list wait) and P7 (not wanting to bug the TA again).',
    categories: [
      { name: 'Affective barriers', codes: ['fear of negative evaluation'] },
      { name: 'Help-seeking behavior', codes: ['help-seeking delay', 'relief after help'] },
    ],
  },
  {
    name: 'Improvised Debugging',
    definition:
      'Without systematic methods, students fall back on self-taught trial-and-error tactics. Evidenced across P3, P7, and P9.',
    categories: [
      { name: 'Strategies', codes: ['improvised debugging strategy', 'googling the error'] },
    ],
  },
  {
    name: 'Error Messages as Barriers',
    definition:
      'Opaque tool output stalls progress and can end a work session. Seen in P7 (type-mismatch error) and P9 (segfault, stack trace).',
    categories: [
      { name: 'Triggers / tooling', codes: ['cryptic error messages', 'reading the stack trace'] },
      { name: 'Outcomes', codes: ['disengagement', 'dreading the next bug'] },
    ],
  },
];

/* ── Stage 6 (Path B): reflexive themes from the same data ── */
export const reflexiveThemes = [
  {
    name: 'Asking for help as social risk',
    definition:
      'Help-seeking is experienced not as a neutral act but as a move that risks one’s standing as a competent student — so it is delayed, hedged, or avoided.',
    categories: [
      { name: 'Identity management', codes: ['managing how I am seen', 'asking as last resort'] },
    ],
  },
  {
    name: 'Debugging as lonely trial-and-error',
    definition: 'In the absence of shared method, debugging becomes a private, improvised, often isolating struggle.',
    categories: [
      { name: 'Improvised practice', codes: ['guessing in the dark', 'outsourcing understanding', 'acting without a model'] },
    ],
  },
  {
    name: 'The error message as gatekeeper',
    definition: 'Tool output is read as withholding access — talking past the novice rather than guiding them in.',
    categories: [
      { name: 'Being shut out', codes: ['tool that talks past me', 'shut out'] },
    ],
  },
];

/**
 * Paired rows for the side-by-side comparison in the Reviewing & Defining Themes
 * lesson — the codebook and reflexive themes describe the SAME phenomenon two
 * ways (they align by index). Derived from the arrays above so theme text has a
 * single source of truth.
 */
const COMPARE_PHENOMENA = ['Help-seeking', 'Debugging approach', 'Error messages'];
const COMPARE_DIFFS = [
  'Path A names the feeling (anxiety about asking); Path B reads what’s at stake — asking risks your standing as a competent student.',
  'Path A catalogs the tactics (improvised, unsystematic); Path B reads the experience — a private, isolating struggle.',
  'Path A treats output as an obstacle that stalls you; Path B reads it as a gatekeeper that withholds access and talks past you.',
];
export const themeComparisonRows = codebookThemes.map((t, i) => ({
  label: COMPARE_PHENOMENA[i],
  left: { title: t.name, body: t.definition },
  right: { title: reflexiveThemes[i].name, body: reflexiveThemes[i].definition },
  diff: COMPARE_DIFFS[i],
}));
