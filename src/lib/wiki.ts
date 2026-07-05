import { getCollection, z, type CollectionEntry } from 'astro:content';
import modulesData from '../data/wiki-modules.json';

export type WikiModule = {
  slug: string;
  title: string;
  order: number;
  icon: string;
  blurb: string;
  /** When true, the module is shown as a placeholder and its lessons are hidden. */
  underConstruction?: boolean;
};

export type WikiLesson = CollectionEntry<'wiki'>;

/** A sidebar nav item: either a standalone lesson or a labelled sub-group of
 *  consecutive lessons (collapsed from their shared `group` frontmatter). */
export type WikiNavItem =
  | { kind: 'lesson'; lesson: WikiLesson }
  | { kind: 'group'; label: string; lessons: WikiLesson[] };

/** A module paired with its ordered lessons (flat) and grouped nav items. */
export type WikiModuleNav = WikiModule & { lessons: WikiLesson[]; items: WikiNavItem[] };

/** Collapse contiguous runs of same-`group` lessons into sub-group nav items;
 *  ungrouped lessons stay at the top level, in their original order. */
function buildNavItems(lessons: WikiLesson[]): WikiNavItem[] {
  const items: WikiNavItem[] = [];
  for (const lesson of lessons) {
    const group = lesson.data.group;
    if (!group) {
      items.push({ kind: 'lesson', lesson });
      continue;
    }
    const last = items[items.length - 1];
    if (last && last.kind === 'group' && last.label === group) {
      last.lessons.push(lesson);
    } else {
      items.push({ kind: 'group', label: group, lessons: [lesson] });
    }
  }
  return items;
}

/** Runtime-validate wiki-modules.json at build time. A malformed or
 *  duplicate-slug entry throws here, failing the build — which is exactly how
 *  the CI gate catches a bad new-module contribution before it merges. */
const moduleSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'module slug must be lowercase-hyphenated'),
  title: z.string().min(1),
  order: z.number(),
  icon: z.string().min(1),
  blurb: z.string().min(1),
  underConstruction: z.boolean().optional(),
});

function parseModules(): WikiModule[] {
  const parsed = z.array(moduleSchema).parse(modulesData);
  const seen = new Set<string>();
  for (const m of parsed) {
    if (seen.has(m.slug)) {
      throw new Error(`Duplicate module slug in wiki-modules.json: "${m.slug}"`);
    }
    seen.add(m.slug);
  }
  return parsed.slice().sort((a, b) => a.order - b.order);
}

const modules = parseModules();

/** Modules flagged under construction — their lessons are hidden everywhere. */
const underConstruction = new Set(
  modules.filter((m) => m.underConstruction).map((m) => m.slug),
);

/**
 * CI escape hatch: when WIKI_RENDER_ALL=1, render EVERY lesson (drafts +
 * under-construction) so `astro build` compiles their MDX bodies. A prod build
 * otherwise skips exactly the new content the editor forms produce, so a broken
 * draft would slip past the build gate. Read from process.env (build-time Node)
 * via globalThis so no @types/node is needed; never set in the deploy env. */
const RENDER_ALL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.WIKI_RENDER_ALL === '1';

/** All modules, sorted by their `order` field. */
export function getModules(): WikiModule[] {
  return modules;
}

export function getModule(slug: string): WikiModule | undefined {
  return modules.find((m) => m.slug === slug);
}

/**
 * All publishable lessons. Drafts are hidden in production builds but visible
 * during `astro dev` so authors can preview work in progress.
 */
export async function getLessons(): Promise<WikiLesson[]> {
  const lessons = await getCollection('wiki', ({ data }) =>
    RENDER_ALL ? true : import.meta.env.PROD ? data.draft !== true : true,
  );
  return lessons
    .filter((l) => RENDER_ALL || !underConstruction.has(l.data.module))
    .sort((a, b) => a.data.order - b.data.order);
}

/** Lessons for one module, ordered. */
export async function getLessonsByModule(slug: string): Promise<WikiLesson[]> {
  const lessons = await getLessons();
  return lessons.filter((l) => l.data.module === slug);
}

/** Modules with their lessons attached — the structure the sidebar renders. */
export async function getWikiNav(): Promise<WikiModuleNav[]> {
  const lessons = await getLessons();
  return modules.map((m) => {
    const modLessons = lessons.filter((l) => l.data.module === m.slug);
    return { ...m, lessons: modLessons, items: buildNavItems(modLessons) };
  });
}

/** Canonical URL for a lesson. Entry id already includes the module folder. */
export function lessonHref(lesson: WikiLesson): string {
  return `/wiki/${lesson.id}`;
}

/** First lesson of a module — used for "start module" links on the landing page. */
export async function firstLessonHref(slug: string): Promise<string | undefined> {
  const lessons = await getLessonsByModule(slug);
  return lessons[0] ? lessonHref(lessons[0]) : undefined;
}

// ── Annotation layer: mapping a lesson back to its MDX source ─────────────────
// The pure helpers live in annotate/links.ts (client-safe, single source of
// truth for the repo/branch); re-exported here for server-side callers.
export { sourcePath as lessonSourcePath, githubEditUrl as lessonGithubEditUrl } from './annotate/links';
