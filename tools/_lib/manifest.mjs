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
  })
  .strict();

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
