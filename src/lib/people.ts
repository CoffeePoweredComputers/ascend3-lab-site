import { getCollection, type CollectionEntry } from 'astro:content';
import { getMember, type Member } from './members';

export type Profile = CollectionEntry<'people'>;
export type Course = Profile['data']['courses'][number];
export type CourseMaterial = Course['materials'][number];

/** Canonical URL for a person's profile page. */
export function profileHref(id: string): string {
  return `/people/${id}`;
}

/**
 * Published profiles joined to their members.json entry.
 *
 * The file id IS the member id, which is the only thing keeping the two halves
 * of a person together. A profile naming an unknown member throws here — the
 * build fails loudly instead of shipping a page with no name or photo.
 *
 * Drafts are hidden in production builds but visible during `astro dev`, the
 * same convention the wiki uses.
 */
export async function getProfilePages(): Promise<{ profile: Profile; member: Member }[]> {
  const profiles = await getCollection('people', ({ data }) =>
    import.meta.env.PROD ? data.draft !== true : true,
  );

  return profiles.map((profile) => {
    const member = getMember(profile.id);
    if (!member) {
      throw new Error(
        `src/content/people/${profile.id}.mdx has no matching entry in src/data/members.json — ` +
          `the filename must be a member "id" (e.g. dhsmith.mdx for id "dhsmith").`,
      );
    }
    return { profile, member };
  });
}

/** Member ids with a published profile — tells the People section which cards link inward. */
export async function getProfileIds(): Promise<Set<string>> {
  const pages = await getProfilePages();
  return new Set(pages.map(({ profile }) => profile.id));
}
