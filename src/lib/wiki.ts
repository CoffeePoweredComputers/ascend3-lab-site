import { getCollection, type CollectionEntry } from 'astro:content';
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

/** A module paired with its ordered, publishable lessons. */
export type WikiModuleNav = WikiModule & { lessons: WikiLesson[] };

const modules = (modulesData as WikiModule[]).slice().sort((a, b) => a.order - b.order);

/** Modules flagged under construction — their lessons are hidden everywhere. */
const underConstruction = new Set(
  modules.filter((m) => m.underConstruction).map((m) => m.slug),
);

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
    import.meta.env.PROD ? data.draft !== true : true,
  );
  return lessons
    .filter((l) => !underConstruction.has(l.data.module))
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
  return modules.map((m) => ({
    ...m,
    lessons: lessons.filter((l) => l.data.module === m.slug),
  }));
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
