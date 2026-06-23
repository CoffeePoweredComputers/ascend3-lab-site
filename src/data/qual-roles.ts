/**
 * "Who does what, and when" — the people-and-handoffs of each tradition, for
 * the RoleWalkthrough component on the Choosing Your Path lesson.
 *
 * Both paths are shown as collaborative (2+ people), so the only variable left
 * is what the second person is *for*: in the codebook path the two coders
 * CONVERGE (reconcile toward one shared codebook); in reflexive TA the two
 * analysts stay DIVERGENT (a critical friend challenges to deepen — never
 * merged, never scored). The two paths share a five-stage spine and align by
 * index so the component can show the same step in the other path.
 *
 * Each step also carries a small `visual` — the artifact that step produces
 * (a memo, two parallel drafts, a consolidation, the shared codebook, themes) —
 * reusing the running-example data so the walkthrough tells the same story as
 * the deeper lessons.
 */
import { codebookEntries, consolidationGroups, reflexiveThemes } from './qual-example';

type Tone = 'neutral' | 'good' | 'warn';

/** A small artifact rendered under a step. */
type Visual =
  | { kind: 'memo'; quote: string; note: string }
  | { kind: 'columns'; groups: { label: string; items: { code: string; tag?: string }[] }[] }
  | { kind: 'consolidation'; raw: string[]; into: string; rationale?: string }
  | { kind: 'codebook'; entries: { code: string; definition: string }[] }
  | { kind: 'themes'; items: { name: string; codes: string[] }[] };

type Step = {
  /** shared spine label */
  stage: string;
  /** role ids active at this step */
  actors: string[];
  /** what they do (1–2 sentences) */
  body: string;
  /** short purpose tag rendered as a badge */
  purpose: string;
  /** badge colour: neutral = independent, good = converge, warn = diverge */
  tone: Tone;
  /** one-liner used as the cross-path contrast */
  summary: string;
  /** the artifact this step produces */
  visual: Visual;
};

type Path = { id: string; label: string; steps: Step[] };

const cbEntries = codebookEntries.slice(0, 3).map((e) => ({ code: e.code, definition: e.definition }));
const reconcile = consolidationGroups[0];
const rtaThemes = reflexiveThemes.slice(0, 2).map((t) => ({
  name: t.name,
  codes: t.categories.flatMap((c) => c.codes),
}));

export const roleWalkthrough: {
  roles: { id: string; label: string; icon: string }[];
  paths: Path[];
} = {
  roles: [
    { id: 'coderA', label: 'Coder A', icon: '🧑‍🔬' },
    { id: 'coderB', label: 'Coder B', icon: '🧑‍🔬' },
    { id: 'analyst', label: 'Analyst', icon: '🪞' },
    { id: 'friend', label: 'Critical friend', icon: '🫂' },
  ],
  paths: [
    {
      id: 'codebook',
      label: 'Codebook / coding-reliability',
      steps: [
        {
          stage: 'Familiarize & memo',
          actors: ['coderA', 'coderB'],
          body: 'Both coders read every transcript and write their own memos and jottings — separately, so first impressions are not anchored to one another.',
          purpose: 'Independent',
          tone: 'neutral',
          summary: 'Both coders read + memo, separately.',
          visual: {
            kind: 'memo',
            quote: 'I sat there for probably an hour before I asked',
            note: 'Jotting: a whole hour stuck before asking — why wait? Social risk? Flag to watch.',
          },
        },
        {
          stage: 'First codes',
          actors: ['coderA', 'coderB'],
          body: 'Each coder drafts their own set of codes on the same few interviews, independently — two parallel first codebooks, not one. The overlap (in different words) is exactly what the next step resolves.',
          purpose: 'Independent',
          tone: 'neutral',
          summary: 'Each drafts their own codes, independently.',
          visual: {
            kind: 'columns',
            groups: [
              {
                label: "Coder A's draft",
                items: [{ code: 'help-seeking delay' }, { code: 'fear of judgment' }, { code: 'trial-and-error' }],
              },
              {
                label: "Coder B's draft",
                items: [{ code: 'waited to ask' }, { code: 'scared to look dumb' }, { code: 'random changes' }],
              },
            ],
          },
        },
        {
          stage: 'The second person…',
          actors: ['coderA', 'coderB'],
          body: 'The two compare their draft codebooks and reconcile them into one shared codebook. Disagreements are resolved by sharpening definitions — not by seniority or averaging.',
          purpose: 'Converge → agreement',
          tone: 'good',
          summary: 'Reconcile the two drafts into one shared codebook.',
          visual: {
            kind: 'consolidation',
            raw: reconcile.raw,
            into: reconcile.consolidated,
            rationale: "Both coders' wording for the same affective barrier → one shared, defined code.",
          },
        },
        {
          stage: 'Expand',
          actors: ['coderA', 'coderB'],
          body: 'They apply the shared codebook to the next set of interviews, add or split codes as needed, and consolidate again — repeating until the codebook stabilizes (constant comparison).',
          purpose: 'Converge (iterate)',
          tone: 'good',
          summary: 'Apply to the next set, expand, consolidate — loop.',
          visual: { kind: 'codebook', entries: cbEntries },
        },
        {
          stage: 'How you defend it',
          actors: ['coderA', 'coderB'],
          body: 'Rigor rests on negotiated consensus plus a documented audit trail. A reported κ/α is a separate claim: once you consolidate, the coders are no longer independent, so a clean coefficient needs a held-out independent pass.',
          purpose: 'Consensus (+ optional IRR)',
          tone: 'good',
          summary: 'Consensus + audit trail (κ only via a held-out pass).',
          visual: {
            kind: 'memo',
            quote: "v0.3 — merged 'felt stupid' into 'fear of negative evaluation'",
            note: 'Audit trail: who changed what, when, and why. The log is the rigor — not a coder rank.',
          },
        },
      ],
    },
    {
      id: 'rta',
      label: 'Reflexive thematic analysis',
      steps: [
        {
          stage: 'Familiarize & memo',
          actors: ['analyst', 'friend'],
          body: 'The analyst and a critical friend read deeply and keep reflexive memos — interrogating their own assumptions and position, not just the data.',
          purpose: 'Immersive',
          tone: 'neutral',
          summary: 'Both read + memo reflexively, separately.',
          visual: {
            kind: 'memo',
            quote: "didn't want the TA to think I was dumb",
            note: 'Reflexive note: am I reading my own student-anxiety into this? What is *their* stake in looking competent?',
          },
        },
        {
          stage: 'First codes',
          actors: ['analyst', 'friend'],
          body: 'Each codes the data for semantic and latent meaning, bringing their own interpretive lens. Two readings are expected — and welcome.',
          purpose: 'Independent',
          tone: 'neutral',
          summary: 'Each codes for semantic + latent meaning.',
          visual: {
            kind: 'columns',
            groups: [
              { label: "Analyst's reading", items: [{ code: 'asking as last resort', tag: 'latent' }] },
              { label: "Critical friend's reading", items: [{ code: 'managing how I am seen', tag: 'latent' }] },
            ],
          },
        },
        {
          stage: 'The second person…',
          actors: ['analyst', 'friend'],
          body: 'They talk. The critical friend challenges the reading — "what makes you see it that way?" — to deepen and complicate it. They do not merge their codes or score agreement.',
          purpose: 'Diverge → depth',
          tone: 'warn',
          summary: 'Critical friend challenges the reading — never merged or scored.',
          visual: {
            kind: 'memo',
            quote: '"the tool talks past me" — the error withholds access',
            note: 'Critical friend: what makes you read it as *withholding* rather than just confusing? Push the interpretation further.',
          },
        },
        {
          stage: 'Construct themes',
          actors: ['analyst', 'friend'],
          body: 'The analyst constructs themes through ongoing discussion. Themes are interpretive outputs owned by the analyst, enriched — not validated — by the dialogue.',
          purpose: 'Diverge (enrich)',
          tone: 'warn',
          summary: 'Construct themes through discussion.',
          visual: { kind: 'themes', items: rtaThemes },
        },
        {
          stage: 'How you defend it',
          actors: ['analyst', 'friend'],
          body: 'Rigor rests on reflexivity, a clear audit trail, and rich theme definitions. Inter-rater reliability is rejected on principle — the second person is here for depth, not agreement.',
          purpose: 'Reflexivity (no IRR)',
          tone: 'neutral',
          summary: 'Reflexivity + audit trail; IRR rejected on principle.',
          visual: {
            kind: 'memo',
            quote: 'Reflexivity statement + audit trail',
            note: "No κ here — a second reader deepened the analysis, they didn't 'agree' with it.",
          },
        },
      ],
    },
  ],
};
