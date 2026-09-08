/**
 * Survey definition schema.
 *
 * A survey is one JSON file in `survey/surveys/`. The file is the instrument:
 * starters are listed explicitly per wave (duplicated verbatim where waves
 * share them) because the IRB instrument says "worded exactly as below" and a
 * flat list is easier to audit than a merge rule. Validation runs at boot and
 * a bad file stops the server from starting — same posture as the Astro
 * site's `wiki-modules.json` (see src/lib/wiki.ts), where a malformed entry
 * fails the build rather than the page.
 *
 * `npm run schema` emits `surveys/survey.schema.json` from this file so editors
 * autocomplete and validate survey files; the `.describe()` texts become the
 * hover documentation there. `npm run validate` checks files without booting.
 */
import { z } from 'zod';

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase-hyphenated (a-z, 0-9, -)');

/** VT PIDs are lowercase; keep the check strict so a stray capital can't silently deny access. */
const pid = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'PID must be lowercase letters/digits');

const isoDatetime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 date-time, e.g. 2026-09-28T00:00:00-04:00');

export const starterSchema = z.object({
  id: slug.describe('Stable id for this question, unique within the wave. Appears in exports.'),
  tag: z.string().min(1).optional().describe('Free label for analysis grouping (e.g. "ambiguity"). Never shown to participants.'),
  text: z.string().min(1).describe('The question exactly as the participant sees it.'),
  maxProbes: z.number().int().min(0).optional().describe('Overrides probing.maxProbesPerStarter for this question only.'),
});

export const waveSchema = z
  .object({
    id: slug.describe('Stable id for the wave (e.g. "w1"). Appears in exports.'),
    label: z.string().min(1).describe('Shown to participants and researchers (e.g. "Project 1").'),
    opensAt: isoDatetime.describe('When participants may start this wave (ISO-8601 with offset).'),
    closesAt: isoDatetime.describe('When the wave closes; active sessions are marked expired after this.'),
    starters: z.array(starterSchema).min(1).describe('The fixed questions, in the order asked. List them in full for every wave.'),
  })
  .superRefine((w, ctx) => {
    if (Date.parse(w.opensAt) >= Date.parse(w.closesAt)) {
      ctx.addIssue({ code: 'custom', message: `wave "${w.id}": opensAt must be before closesAt`, path: ['closesAt'] });
    }
    const seen = new Set<string>();
    for (const s of w.starters) {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', message: `wave "${w.id}": duplicate starter id "${s.id}"`, path: ['starters'] });
      seen.add(s.id);
    }
  });

const surveyObject = z.object({
  $schema: z.string().optional().describe('Editor hint only, e.g. "./survey.schema.json". Ignored by the service and excluded from the config version.'),
  id: slug.describe('Survey id; the file must be named <id>.json and participants open /survey/s/<id>.'),
  title: z.string().min(1).describe('Shown in the page header and admin.'),
  irbProtocol: z.string().optional().describe('e.g. "VT IRB #26-817". Shown to researchers only.'),
  notes: z.string().optional().describe('Free-text operator notes (JSON has no comments). Never shown to participants.'),
  status: z
    .enum(['draft', 'open', 'closed'])
    .describe('draft = invisible to participants (researchers can still preview); open = sessions may start; closed = no new sessions, key may be destroyed.'),
  roles: z.object({
    researchers: z.array(pid).describe('PIDs who may view/export CODED data and run preview sessions.'),
    keyholders: z.array(pid).describe('PIDs who may upload the roster, export the PID↔code key, and destroy it.'),
  }),
  eligibility: z
    .object({
      requireAdult: z.boolean().default(true).describe('Require the 18+ confirmation at consent.'),
      roster: z
        .enum(['none', 'optional', 'required'])
        .default('none')
        .describe('none = anyone with a VT login; optional = roster match recorded but not enforced; required = must be on the keyholder-uploaded roster.'),
    })
    .default({ requireAdult: true, roster: 'none' }),
  consent: z.object({
    sheetMarkdown: z.string().min(1).describe('The information sheet, Markdown. Rendered once at boot; also served printable at /s/<id>/info-sheet.'),
    agreeLabel: z.string().min(1).describe('Text beside the consent checkbox.'),
    declineLabel: z.string().min(1).default('I do not wish to participate'),
    ferpa: z
      .object({
        enabled: z.boolean(),
        label: z.string().min(1).describe('Text beside the optional records-release checkbox.'),
        requireNameAndDate: z.boolean().default(true).describe('Require a typed full name and date when the box is ticked (stored in the keyring only).'),
      })
      .optional()
      .describe('Optional separate permission (e.g. FERPA records release). Omit if not needed.'),
  }),
  opening: z.string().min(1).describe('Shown before the first question and as the first message of the conversation.'),
  closing: z.string().min(1).describe('Shown when the session ends.'),
  waves: z.array(waveSchema).min(1).describe('One or more non-overlapping windows. A participant gets one session per wave.'),
  probing: z.object({
    protocol: z.string().min(1).describe('Name of the probing protocol, for the record (e.g. "DICE").'),
    maxProbesPerStarter: z.number().int().min(0).describe('Follow-ups allowed per question before moving on.'),
    maxTurnsPerSession: z
      .number()
      .int()
      .min(1)
      .describe('Cap on questions presented per session (starters + follow-ups). Starters are always presented; the cap trims follow-ups.'),
    probeTypes: z.array(z.string().min(1)).min(1).describe('Allowed probe_type labels. A reply with any other label is treated as a parse error and the session moves on.'),
    moveOnToken: z.string().min(1).default('MOVE_ON').describe('Literal the model outputs to end the follow-ups on a question.'),
    maxQuestionWords: z.number().int().min(1).default(25).describe('Follow-ups longer than this are still asked but flagged "overlength".'),
    systemPrompt: z.string().min(1).describe('The fixed, researcher-authored system prompt. Must mention moveOnToken and require {"probe_type","trigger","question"} JSON.'),
  }),
  model: z.object({
    name: z.string().min(1).describe('ARC model id, e.g. "gpt-oss-120b-thinking-low". See `npm run bench:model`.'),
    temperature: z.number().min(0).max(2).default(0.3),
    /** Reasoning models (gpt-oss) spend tokens thinking before the JSON; 300 was observed to truncate. */
    maxTokens: z.number().int().min(16).default(1200).describe('Completion budget. Reasoning models count their thinking against it; 1200 is a safe floor.'),
    timeoutMs: z.number().int().min(1000).default(45_000).describe('Per-call timeout. On timeout the session moves on and records llm_error.'),
    reasoningEffort: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe('Sent as `reasoning_effort` (OpenAI-compatible). Lower = faster. ARC also exposes `-thinking-low/-high` model ids.'),
  }),
});

export const surveySchema = surveyObject.superRefine((s, ctx) => {
  const waveIds = new Set<string>();
  for (const w of s.waves) {
    if (waveIds.has(w.id)) ctx.addIssue({ code: 'custom', message: `duplicate wave id "${w.id}"`, path: ['waves'] });
    waveIds.add(w.id);
    if (s.probing.maxTurnsPerSession < w.starters.length) {
      ctx.addIssue({
        code: 'custom',
        message: `wave "${w.id}" has ${w.starters.length} starters but probing.maxTurnsPerSession is ${s.probing.maxTurnsPerSession}`,
        path: ['probing', 'maxTurnsPerSession'],
      });
    }
  }
  const sorted = [...s.waves].sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (Date.parse(cur.opensAt) < Date.parse(prev.closesAt)) {
      ctx.addIssue({ code: 'custom', message: `waves "${prev.id}" and "${cur.id}" overlap`, path: ['waves'] });
    }
  }
  if (!s.probing.systemPrompt.includes(s.probing.moveOnToken)) {
    ctx.addIssue({
      code: 'custom',
      message: `probing.systemPrompt never mentions the move-on token "${s.probing.moveOnToken}"`,
      path: ['probing', 'systemPrompt'],
    });
  }
  const upper = s.probing.probeTypes.map((t) => t.toUpperCase());
  if (new Set(upper).size !== upper.length) {
    ctx.addIssue({ code: 'custom', message: 'probing.probeTypes has duplicates (case-insensitive)', path: ['probing', 'probeTypes'] });
  }
});

export type SurveyConfig = z.infer<typeof surveySchema>;
export type Wave = z.infer<typeof waveSchema>;
export type Starter = z.infer<typeof starterSchema>;

/** Effective probe limit for one starter. */
export function maxProbesFor(cfg: SurveyConfig, starter: Starter): number {
  return starter.maxProbes ?? cfg.probing.maxProbesPerStarter;
}

/** Human-readable zod error for boot logs. */
export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/**
 * JSON Schema (draft 2020-12) for editors. `io: 'input'` keeps fields with
 * defaults optional, which is what a hand-written file needs. Cross-field
 * checks (overlapping waves, prompt mentions the token) cannot be expressed
 * here — `npm run validate` enforces those.
 */
export function surveyJsonSchema(): Record<string, unknown> {
  const js = z.toJSONSchema(surveyObject, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema, ...rest } = js;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ascend3.cs.vt.edu/survey/survey.schema.json',
    title: 'ASCEND adaptive survey definition',
    description:
      'One file per survey in survey/surveys/<id>.json. Fixed starter questions per wave; an LLM asks up to N follow-ups per question under the systemPrompt. Cross-field rules (non-overlapping waves, prompt mentions the move-on token, cap ≥ starters) are checked by `npm run validate`, not by this schema.',
    ...rest,
  };
}
