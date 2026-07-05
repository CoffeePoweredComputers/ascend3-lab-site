/**
 * Frontmatter parse/serialize for wiki MDX.
 *
 * Uses js-yaml — the same YAML engine Astro's content layer uses (via
 * gray-matter) — so a round-trip through the editor never corrupts a real
 * value: a quoted title, an em-dash and slash in `group` ("Path A — Codebook /
 * IRR"), or a colon inside a description all survive. A hand-rolled `---`
 * splitter would silently mangle these; that is why we take the dependency.
 *
 * Client-safe (js-yaml runs in the browser): the edit island fetches raw MDX
 * from GitHub, parses it here to populate a typed form, and re-serializes on
 * submit.
 */
// js-yaml (v5) is ESM with named exports and no default export, so a default
// import fails in the browser ("doesn't provide an export named: 'default'").
import * as yaml from 'js-yaml';

/** Matches a leading `---` YAML block and the single newline after its close. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export interface ParsedMdx {
  /** Parsed frontmatter object ({} if the file has no frontmatter). */
  data: Record<string, unknown>;
  /** The MDX body after the frontmatter block. */
  body: string;
}

/** The frontmatter keys the wiki content schema knows about (content.config.ts). */
export interface WikiFrontmatter {
  title: string;
  module: string;
  order: number;
  group?: string;
  description?: string;
  estMinutes?: number;
  draft?: boolean;
}

const KNOWN_KEYS = new Set([
  'title',
  'module',
  'order',
  'group',
  'description',
  'estMinutes',
  'draft',
]);

/** Split leading `---` frontmatter from the MDX body. */
export function parseFrontmatter(mdx: string): ParsedMdx {
  const match = mdx.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: mdx };
  const loaded = yaml.load(match[1]);
  const data =
    loaded && typeof loaded === 'object' && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : {};
  return { data, body: mdx.slice(match[0].length) };
}

/**
 * Re-emit MDX from a frontmatter object + body. Numbers are dumped unquoted so
 * the content schema's `z.number()` accepts `order`/`estMinutes`; js-yaml quotes
 * only values that actually need it. Output is normalized to
 * `---\n<yaml>\n---\n\n<body>` (one blank line before the body).
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = yaml
    .dump(data, {
      lineWidth: -1, // never wrap — keep long descriptions on one line
      quotingType: '"', // use double quotes when quoting is required
      forceQuotes: false, // only quote when necessary
      noRefs: true,
      sortKeys: false, // preserve the insertion order we build below
    })
    .replace(/\n$/, '');
  return `---\n${yamlText}\n---\n\n${body.replace(/^\s*\n/, '')}`;
}

/**
 * Build a frontmatter object in canonical key order, omitting empty optionals
 * (so we don't emit `group:` / `description:` with blank values, and only write
 * `draft: true` when actually drafting — the schema defaults draft to false).
 *
 * Any keys present on `existing` that the schema doesn't know about are carried
 * through unchanged, so editing a lesson never drops an unrecognized field.
 */
export function buildFrontmatter(
  fm: WikiFrontmatter,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: fm.title,
    module: fm.module,
    order: fm.order,
  };
  if (fm.group && fm.group.trim()) out.group = fm.group.trim();
  if (fm.description && fm.description.trim()) out.description = fm.description.trim();
  if (typeof fm.estMinutes === 'number' && !Number.isNaN(fm.estMinutes)) {
    out.estMinutes = fm.estMinutes;
  }
  if (fm.draft) out.draft = true;

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }
  return { ...out, ...extra };
}

/** Coerce a parsed frontmatter object into the typed shape the edit form uses. */
export function toWikiFrontmatter(data: Record<string, unknown>): WikiFrontmatter {
  return {
    title: typeof data.title === 'string' ? data.title : '',
    module: typeof data.module === 'string' ? data.module : '',
    order: typeof data.order === 'number' ? data.order : Number(data.order) || 0,
    group: typeof data.group === 'string' ? data.group : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    estMinutes:
      typeof data.estMinutes === 'number'
        ? data.estMinutes
        : data.estMinutes != null
          ? Number(data.estMinutes)
          : undefined,
    draft: data.draft === true,
  };
}
