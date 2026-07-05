import { z } from 'astro:content';
import projectsData from '../data/undergrad-projects.json';
import membersData from '../data/members.json';
import { getLessons, lessonHref } from './wiki';

/**
 * `undergrad-projects.json` — recruiting content for the undergraduate research
 * panels (/undergrad). Distinct from `research.json` (the public research-thrust
 * list on the home page): these are pitched at a prospective undergrad and carry
 * team/mentor + "what you'd do" info the public list doesn't need.
 */

export type ProjectArea = 'tools' | 'qual' | 'assessment';
export type ProjectStatus = 'recruiting' | 'running' | 'full';

export interface ProjectMaterial {
  label: string;
  href: string;
  kind: 'repo' | 'paper' | 'dataset' | 'doc' | 'figma';
  access: 'public' | 'members';
}

export interface UndergradPersonRef {
  id: string;
  name: string;
  role: string;
  photo?: string | null;
  website?: string | null;
}

export interface UndergradProject {
  slug: string;
  title: string;
  /** Compact name for the flipbook tab strip; falls back to `title`. */
  shortTitle: string;
  area: ProjectArea;
  status: ProjectStatus;
  prereq: string;
  lede: string;
  mentor: UndergradPersonRef | null;
  team: UndergradPersonRef[];
  materials: ProjectMaterial[];
  wikiLinks: { title: string; href: string }[];
}

/** Runtime-validated at build time, same pattern as wiki.ts's moduleSchema — a
 *  malformed or duplicate-slug entry fails the build rather than the page. */
const projectSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'project slug must be lowercase-hyphenated'),
  title: z.string().min(1),
  shortTitle: z.string().optional(),
  area: z.enum(['tools', 'qual', 'assessment']),
  status: z.enum(['recruiting', 'running', 'full']),
  prereq: z.string(),
  lede: z.string(),
  mentorId: z.string(),
  teamIds: z.array(z.string()),
  materials: z.array(
    z.object({
      label: z.string(),
      href: z.string(),
      kind: z.enum(['repo', 'paper', 'dataset', 'doc', 'figma']),
      access: z.enum(['public', 'members']),
    }),
  ),
  wikiLinks: z.array(z.string()),
});

function parseProjects() {
  const parsed = z.array(projectSchema).parse(projectsData);
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.slug)) {
      throw new Error(`Duplicate project slug in undergrad-projects.json: "${p.slug}"`);
    }
    seen.add(p.slug);
  }
  return parsed;
}

const rawProjects = parseProjects();

// members.json groups people by category (pi/phd/masters/.../collaborators);
// flatten to one id → person lookup so a project's mentorId/teamIds can point
// at anyone regardless of which category they're filed under.
interface RawPerson {
  id: string;
  name: string;
  role: string;
  photo?: string | null;
  website?: string | null;
}
interface MembersFile {
  pi: RawPerson;
  phd: RawPerson[];
  masters: RawPerson[];
  highschool: RawPerson[];
  undergrad: RawPerson[];
  collaborators: RawPerson[];
}
const md = membersData as unknown as MembersFile;
const memberIndex = new Map<string, RawPerson>(
  [md.pi, ...md.phd, ...md.masters, ...md.highschool, ...md.undergrad, ...md.collaborators].map(
    (p) => [p.id, p],
  ),
);

function personRef(id: string): UndergradPersonRef | null {
  const p = memberIndex.get(id);
  return p ? { id: p.id, name: p.name, role: p.role, photo: p.photo, website: p.website } : null;
}

/** All undergrad research-panel projects, with mentor/team and wiki links
 *  resolved to live lesson data. A `wikiLinks` entry pointing at a lesson that's
 *  hidden (under-construction module, draft) is silently dropped — same rule
 *  the sidebar itself follows, so a dossier never links to a dead page. */
export async function getUndergradProjects(): Promise<UndergradProject[]> {
  const lessons = await getLessons();
  const lessonById = new Map(lessons.map((l) => [l.id, l]));
  return rawProjects.map((p) => ({
    slug: p.slug,
    title: p.title,
    shortTitle: p.shortTitle ?? p.title,
    area: p.area,
    status: p.status,
    prereq: p.prereq,
    lede: p.lede,
    mentor: personRef(p.mentorId),
    team: p.teamIds.map(personRef).filter((x): x is UndergradPersonRef => x !== null),
    materials: p.materials,
    wikiLinks: p.wikiLinks
      .map((id) => {
        const lesson = lessonById.get(id);
        return lesson ? { title: lesson.data.title, href: lessonHref(lesson) } : null;
      })
      .filter((x): x is { title: string; href: string } => x !== null),
  }));
}

export async function getUndergradProject(slug: string): Promise<UndergradProject | undefined> {
  const all = await getUndergradProjects();
  return all.find((p) => p.slug === slug);
}
