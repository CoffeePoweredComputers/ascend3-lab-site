/**
 * Client-safe helpers mapping a lesson slug to its MDX source path + GitHub
 * "edit this file" deep-link. Kept separate from wiki.ts (which imports
 * astro:content and is server-only) so client islands can use them too.
 *
 * A lesson's collection `id` already includes the module folder (e.g.
 * "qualitative/inter-rater-reliability"), so the mapping is 1:1.
 */
export const GITHUB_REPO = 'CoffeePoweredComputers/ascend3-lab-site';
export const GITHUB_BRANCH = 'master';

/** Repo-relative path of a lesson's MDX source. */
export function sourcePath(lessonSlug: string): string {
  return `src/content/wiki/${lessonSlug}.mdx`;
}

/** GitHub "edit this file" deep-link for a lesson's MDX source. */
export function githubEditUrl(lessonSlug: string): string {
  return `https://github.com/${GITHUB_REPO}/edit/${GITHUB_BRANCH}/${sourcePath(lessonSlug)}`;
}

/**
 * A unique branch name for a wiki contribution PR. `kind` is the proposal kind
 * (edit/new-lesson/new-module/publish); `key` is a slug or module name. The
 * base-36 timestamp keeps repeated contributions to the same target from
 * colliding on the branch ref. Client-side only (uses Date.now).
 */
export function wikiBranchName(kind: string, key: string): string {
  const safe = key
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `wiki-${kind}-${safe}-${Date.now().toString(36)}`;
}

export interface IssueSource {
  type: string;
  lessonSlug: string;
  note: string;
  reference: string; // the quoted passage, or "Widget: <label>"
  author: string;
  contextUrl: string; // absolute /wiki/<slug>?report=<id> link
}

/**
 * Title/body/labels for a GitHub issue built from a report. Shared by both the
 * deep-link (`githubIssueUrl`) and the API path (`createGithubIssue`) so the two
 * produce identical issues.
 */
export function githubIssueContent(r: IssueSource): { title: string; body: string; labels: string[] } {
  const quoted = r.reference
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const body = [
    `**Reported by:** ${r.author}`,
    `**Lesson:** \`${r.lessonSlug}\``,
    `**Type:** ${r.type}`,
    '',
    '**Note**',
    r.note,
    '',
    '**Referenced content**',
    quoted,
    '',
    `[View in context](${r.contextUrl}) · [Edit lesson source](${githubEditUrl(r.lessonSlug)})`,
    '',
    '_Filed from the Lab Wiki review queue._',
  ].join('\n');
  return { title: `[wiki] ${r.type}: ${r.lessonSlug}`, body, labels: ['wiki', r.type] };
}

/**
 * Deep-link to GitHub's "new issue" form, pre-filled from a report (the tokenless
 * fallback — the admin reviews and clicks Submit on GitHub).
 */
export function githubIssueUrl(r: IssueSource): string {
  const { title, body, labels } = githubIssueContent(r);
  const params = new URLSearchParams({ title, body, labels: labels.join(',') });
  return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
}
