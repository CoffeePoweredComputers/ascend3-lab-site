/**
 * Open a wiki-content pull request straight from the browser, using the signed-in
 * editor's own GitHub token (minted by github.ts via Firebase's GitHub provider).
 *
 * The editor is an upstream COLLABORATOR, so there is no fork: we push a branch
 * directly to the repo via the Git Data API (blobs → tree → commit → ref) and
 * open a same-repo PR. Branch protection on `master` (require PR + review) is the
 * real gate; this file is just the plumbing.
 *
 * Safety that does NOT depend on branch protection:
 *  - a hard path allowlist (only wiki lesson MDX + the module registry may be
 *    written) so a bug or a malicious form can't smuggle a commit to config/rules;
 *  - baseSha drift detection so an editor is warned when the file changed under
 *    them since they loaded it;
 *  - the module registry is merged against LIVE master (not a stale client copy)
 *    with a duplicate-slug guard.
 */
import { GITHUB_REPO, GITHUB_BRANCH, wikiBranchName } from './links';
import { getToken, resetToken } from './github';

// ── path allowlist ───────────────────────────────────────────────────────────
const WIKI_MDX_RE = /^src\/content\/wiki\/[A-Za-z0-9._/-]+\.mdx$/;
const MODULES_JSON = 'src/data/wiki-modules.json';

function assertAllowedPath(path: string): void {
  if (path.includes('..')) throw new Error(`Refusing path traversal: ${path}`);
  if (path === MODULES_JSON) return;
  if (WIKI_MDX_RE.test(path)) return;
  throw new Error(`Refusing to write disallowed path: ${path}`);
}

// ── types ────────────────────────────────────────────────────────────────────
export interface WikiFile {
  path: string;
  /** Full new UTF-8 text of the file (a snapshot, not a diff). */
  content: string;
  /** Blob sha the edit was based on, for drift detection (omit for new files). */
  baseSha?: string;
}

export interface ModuleEntryInput {
  slug: string;
  title: string;
  order: number;
  icon: string;
  blurb: string;
  underConstruction?: boolean;
}

/** Flip an existing module's underConstruction flag (used by the publish flow). */
export interface ModuleUpdateInput {
  slug: string;
  underConstruction: boolean;
}

export interface OpenPrInput {
  kind: 'edit' | 'new-lesson' | 'new-module' | 'publish';
  /** Slug/module used to name the branch. */
  branchKey: string;
  title: string;
  body: string;
  files: WikiFile[];
  /** For kind 'new-module': merged into wiki-modules.json against live master. */
  moduleEntry?: ModuleEntryInput | null;
  /** For kind 'publish' of a module: patch an existing registry entry live. */
  moduleUpdate?: ModuleUpdateInput | null;
}

export interface OpenedPr {
  url: string;
  number: number;
  branch: string;
  /** Human-readable warnings about files that changed on master since load. */
  drift: string[];
}

export interface MasterFile {
  text: string;
  sha: string;
}

// ── utf-8-safe base64 decode (GitHub Contents API returns base64) ─────────────
function b64ToUtf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Read a file from master. Unauthenticated by default (no popup on page load;
 * subject to GitHub's 60/hr per-IP limit). Pass a token to use the 5000/hr rate.
 * Returns null if the file does not exist (used for new-content flows).
 */
export async function readFileFromMaster(path: string, token?: string): Promise<MasterFile | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURI(path)}?ref=${GITHUB_BRANCH}`,
    { headers },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} reading ${path}: ${t.slice(0, 160) || res.statusText}`);
  }
  const data = (await res.json()) as { content?: string; sha: string };
  return { text: b64ToUtf8(data.content ?? ''), sha: data.sha };
}

interface GhError extends Error {
  status?: number;
  body?: string;
}

/**
 * Open the PR. Runs the whole Git Data sequence with the editor's token; a 401
 * mid-flight re-mints the token once (github.ts caches it in tab memory).
 */
export async function openWikiPullRequest(input: OpenPrInput): Promise<OpenedPr> {
  const { kind, branchKey, title, body, files, moduleEntry, moduleUpdate } = input;

  for (const f of files) assertAllowedPath(f.path);
  if (files.length === 0 && !moduleEntry && !moduleUpdate) throw new Error('Nothing to commit.');

  let token = await getToken();

  // Authenticated call helper with a single 401 re-mint retry.
  async function call<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const doFetch = (t: string) =>
      fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    let res = await doFetch(token);
    if (res.status === 401) {
      resetToken();
      token = await getToken(true);
      res = await doFetch(token);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: GhError = new Error(
        `GitHub ${res.status}: ${text.slice(0, 220) || res.statusText}`,
      );
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  // 1. Base commit + tree.
  const ref = await call<{ object: { sha: string } }>(`/git/ref/heads/${GITHUB_BRANCH}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await call<{ tree: { sha: string } }>(`/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  // 2. Assemble tree entries + collect drift warnings.
  const drift: string[] = [];
  const tree: Array<{ path: string; mode: '100644'; type: 'blob'; content: string }> = [];

  for (const f of files) {
    if (f.baseSha) {
      const current = await readFileFromMaster(f.path, token);
      if (!current) {
        drift.push(`${f.path} no longer exists on master (it may have been removed).`);
      } else if (current.sha !== f.baseSha) {
        drift.push(`${f.path} changed on master since you loaded it — review the PR diff carefully.`);
      }
    }
    tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
  }

  // 3. Module registry: merge into live master, guard duplicate slugs.
  if (moduleEntry) {
    const current = await readFileFromMaster(MODULES_JSON, token);
    const arr = current ? (JSON.parse(current.text) as ModuleEntryInput[]) : [];
    if (arr.some((m) => m.slug === moduleEntry.slug)) {
      throw new Error(`A module with slug "${moduleEntry.slug}" already exists.`);
    }
    const entry: ModuleEntryInput = {
      slug: moduleEntry.slug,
      title: moduleEntry.title,
      order: moduleEntry.order,
      icon: moduleEntry.icon,
      blurb: moduleEntry.blurb,
    };
    if (moduleEntry.underConstruction) entry.underConstruction = true;
    arr.push(entry);
    arr.sort((a, b) => a.order - b.order);
    tree.push({
      path: MODULES_JSON,
      mode: '100644',
      type: 'blob',
      content: `${JSON.stringify(arr, null, 2)}\n`,
    });
  }

  // 3b. Publish a module: live-patch its registry entry's underConstruction flag.
  if (moduleUpdate) {
    const current = await readFileFromMaster(MODULES_JSON, token);
    if (!current) throw new Error(`${MODULES_JSON} not found on master.`);
    const arr = JSON.parse(current.text) as ModuleEntryInput[];
    const entry = arr.find((m) => m.slug === moduleUpdate.slug);
    if (!entry) throw new Error(`Module "${moduleUpdate.slug}" not found in the registry.`);
    if (moduleUpdate.underConstruction) entry.underConstruction = true;
    else delete entry.underConstruction;
    tree.push({
      path: MODULES_JSON,
      mode: '100644',
      type: 'blob',
      content: `${JSON.stringify(arr, null, 2)}\n`,
    });
  }

  // 4. Tree → commit (author is the token's user — no explicit author needed).
  const newTree = await call<{ sha: string }>(`/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  const commit = await call<{ sha: string }>(`/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: title, tree: newTree.sha, parents: [baseCommitSha] }),
  });

  // 5. Create the branch ref (retry once with a fresh name if it somehow exists).
  let branch = wikiBranchName(kind, branchKey);
  try {
    await call(`/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  } catch (e) {
    if ((e as GhError).status === 422) {
      branch = wikiBranchName(kind, `${branchKey}-x`);
      await call(`/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    } else {
      throw e;
    }
  }

  // 6. Open the PR; label it (labels are best-effort).
  const pr = await call<{ html_url: string; number: number }>(`/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, body, head: branch, base: GITHUB_BRANCH }),
  });
  try {
    await call(`/issues/${pr.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: ['wiki', kind] }),
    });
  } catch {
    /* labels are cosmetic; ignore failures */
  }

  return { url: pr.html_url, number: pr.number, branch, drift };
}
