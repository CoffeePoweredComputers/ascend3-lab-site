/**
 * The tool.json contract, shared by the runner (tools/_lib/deploy.mjs), the
 * site build (src/lib/lab-tools.ts) and CI. One schema, so a manifest the wiki
 * lists is exactly a manifest the runner deploys.
 *
 * `astro/zod` rather than a separate zod dependency: it is the copy the site
 * already ships, and the server checkout has the root node_modules, so plain
 * Node under cron resolves it too.
 */
import { z } from 'astro/zod';

/** Directory name = tool name = URL segment (/tools/<name>/). Underscore
 *  prefixes are reserved for infrastructure (tools/_gate, tools/_lib). */
export const TOOL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const toolManifestSchema = z
  .object({
    /** Shown on the wiki card and in the sidebar. */
    title: z.string().trim().min(1).max(80),
    /** One sentence for the wiki card. */
    blurb: z.string().trim().min(1).max(300),
    /** One emoji, like the wiki modules use. */
    icon: z.string().trim().min(1).max(8),
    /** Who to contact about the tool, e.g. "pid@vt.edu". */
    owner: z.string().trim().min(3).max(120),
    /**
     * Who may open the tool.
     *  - "members" (default): approved lab members only.
     *  - "participants": a study instrument. Any verified @vt.edu sign-in is
     *    admitted and assigned the participant role at sign-in, until
     *    `participantsUntil`. Members are admitted too.
     */
    access: z.enum(['members', 'participants']).default('members'),
    /** Study end date, YYYY-MM-DD, inclusive (end of that day, Eastern time).
     *  Required when access is "participants". After it no participant can
     *  sign in and their participant records auto-delete (Firestore TTL). */
    participantsUntil: z.string().regex(YMD_RE, 'must be YYYY-MM-DD').refine(validYmd, 'not a real date').optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.access === 'participants' && !m.participantsUntil) {
      ctx.addIssue({ code: 'custom', path: ['participantsUntil'], message: 'required when access is "participants"' });
    }
    if (m.access === 'members' && m.participantsUntil) {
      ctx.addIssue({ code: 'custom', path: ['participantsUntil'], message: 'only meaningful with access: "participants"' });
    }
  });

/**
 * Parse a raw tool.json value; throws an Error whose message lists every
 * problem on one line each, so a student sees all of them at once.
 * @param {unknown} raw
 */
export function parseManifest(raw) {
  const r = toolManifestSchema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(lines.join('; '));
}
