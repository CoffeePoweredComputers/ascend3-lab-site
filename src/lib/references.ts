import referencesData from '../data/references.json';

export type Reference = {
  id: string;
  type: 'article' | 'book' | 'report';
  cite: string;
  apa: string;
  doi?: string;
  url: string;
  annotation: string;
  tags: string[];
  verified: boolean;
};

const references = referencesData as Reference[];
const byId = new Map(references.map((r) => [r.id, r]));

/** Look up a single reference by id. */
export function getReference(id: string): Reference | undefined {
  return byId.get(id);
}

/**
 * References, optionally filtered to those carrying ANY of the given tags,
 * sorted alphabetically by their citation label (author/year).
 */
export function getReferences(tags?: string[]): Reference[] {
  const list = tags?.length
    ? references.filter((r) => r.tags.some((t) => tags.includes(t)))
    : references.slice();
  return list.sort((a, b) => a.cite.localeCompare(b.cite));
}
