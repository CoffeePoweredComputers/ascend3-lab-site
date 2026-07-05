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

export const collections = { wiki };
