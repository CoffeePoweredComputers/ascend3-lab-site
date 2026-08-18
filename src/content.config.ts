import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * `wiki` — interactive learning lessons authored as MDX.
 *
 * One file per submodule (lesson). The folder name is the module slug and must
 * match a `slug` in src/data/wiki-modules.json. Lessons are ordered within a
 * module by the `order` field. Edit these files on GitHub to publish changes.
 */
const wiki = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/wiki' }),
  schema: z.object({
    title: z.string(),
    module: z.string(),
    order: z.number(),
    /** Optional sub-group label; contiguous lessons sharing one are nested
     *  under a collapsible sub-heading in the sidebar (e.g. "Path A — …"). */
    group: z.string().optional(),
    description: z.string().optional(),
    estMinutes: z.number().optional(),
    draft: z.boolean().default(false),
  }),
});

/**
 * `people` — public profile pages at /people/<id>.
 *
 * One file per person, named for that person's `id` in src/data/members.json
 * (dhsmith.mdx → /people/dhsmith). Identity — name, role, photo, email, website,
 * institution — is NOT repeated here: it stays in members.json and is joined by
 * id at build time, so a card and a profile can never disagree. This collection
 * adds only what a card has no room for: the long-form bio (the MDX body) and
 * teaching. Profiles are opt-in — a page exists only where a file exists.
 */
const people = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/people' }),
  schema: z.object({
    /** One-line summary under the name, e.g. areas of work. */
    headline: z.string().optional(),
    courses: z
      .array(
        z.object({
          /** Course number as students know it, e.g. "CS 1114". */
          code: z.string(),
          title: z.string(),
          /** Instructor, Co-instructor, TA… */
          role: z.string().optional(),
          /** Offerings taught, newest first: ["Fall 2026", "Spring 2026"]. */
          terms: z.array(z.string()).default([]),
          institution: z.string().optional(),
          description: z.string().optional(),
          /** Slide decks, syllabus, repo — a published deck is just
           *  { label, url: "/slides/<slug>/", kind: "slides" }. */
          materials: z
            .array(
              z.object({
                label: z.string(),
                url: z.string(),
                kind: z
                  .enum(['slides', 'syllabus', 'repo', 'video', 'notes', 'site'])
                  .optional(),
              }),
            )
            .default([]),
        }),
      )
      .default([]),
    /** Profile links beyond the website/email already in members.json. */
    links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { wiki, people };
