# Lab Wiki — In-App Editing (Editor-Native)

Let **editors** — approved lab members who have linked GitHub and been given repo access —
edit content and **open their own PRs** from the page. Review, conflicts, and merge happen
**natively on GitHub**. No backend, no admin bottleneck, no Firestore proposal queue.

---

## ✅ STATUS: BUILT — CodeMirror editor + preview channel (preview pending your secret)

The contribution system is implemented, now with a **CodeMirror 6** source editor
(`src/lib/annotate/editor.ts`) on `/wiki/edit` and `/wiki/new` — Markdown highlighting,
bracket matching, line wrapping, insert-only formatting toolbar; syncs the hidden textarea so
`pr.ts`/`frontmatter.ts` are untouched and diffs stay byte-clean.

**MDXEditor was evaluated and rejected** (ultracode workflow, last place 40.75 vs 103.75):
whole-file re-serialization → noisy diffs, 64 inline `<Cite>` become opaque boxes, React
weight, and it still can't render your build-time Astro components. Fidelity instead comes from
a **per-PR real-build preview channel** (`wiki-build-check.yml` extended: build once = gate,
best-effort deploy to a Firebase Hosting preview channel). It is **inert until you create the
`FIREBASE_SERVICE_ACCOUNT` repo secret** — which doesn't exist yet (your `deploy.yml` has been
failing for the same reason; the site is actually nginx-hosted at ascend3.cs.vt.edu, not
Firebase Hosting). The local split-pane preview was deliberately not built (false-confidence
trap). Not done: nothing outstanding except that one secret + your GitHub-provider/collaborator
setup below.

**Files added:** `src/lib/annotate/frontmatter.ts`, `pr.ts`; `src/pages/wiki/edit.astro`,
`new.astro`, `publish.astro`; `.github/workflows/wiki-build-check.yml`.
**Files changed:** `github.ts` (export getToken/resetToken), `links.ts` (export GITHUB_BRANCH
+ wikiBranchName), `types.ts` (Member.editor), `auth.ts` (isEditor), `members.ts`
(setMemberEditor), `wiki.ts` (Zod-validate modules + WIKI_RENDER_ALL), `[...slug].astro`
("Edit this page"), `review.astro` (editor toggle), `firestore.rules` (create-hardening),
`wiki.css` (styles), `astro.config.mjs` (js-yaml pre-bundle). Added dep: `js-yaml`.

**Your setup steps (only you can do these — they gate real end-to-end use):**
1. Deploy the hardened rules: `firebase deploy --only firestore:rules`.
2. Enable the **GitHub auth provider** in Firebase (GitHub OAuth App; callback = Firebase auth
   handler). Also unblocks the issue-filer.
3. Per editor: toggle **Make editor** in `/admin` → Members **AND** add them as a GitHub
   **collaborator** (write). Both are required — the flag shows the UI, the collaborator grant
   authorizes the PR.
4. **Branch protection** on `master`: require a PR, require the **Wiki build check** status
   check, require ≥1 approving review, block direct pushes.

**How it's used:** editor signs in → "Edit this page" appears on lessons → edit → *Open pull
request* (authored by them). New content at `/wiki/new`; reveal hidden content at
`/wiki/admin` → Publish (admin).

**Chosen model:** editor-native, collaborator-based (Option A). Editors are added as GitHub
**collaborators** with **branch protection on `master`**, so their browser token can push a
branch and open a same-repo PR — reusing the PR code with **no fork logic**.

> Superseded: the earlier "Firestore proposal queue + admin-bridged PR" design (for members
> *without* GitHub) is dropped per the "editors only" decision. If you ever need GitHub-less
> members to contribute, that queue is the documented fallback to add back later.

---

## 0. The one honest ceiling — read this first

**In-app editing is prose-only.** Our ~19 interactive widgets (`DecisionTree`,
`KappaCalculator`, `ProcessFlow`, …) have data in `src/data/*.ts` and JS-expression props — no
browser MDX editor can render them live or round-trip them. Editors comfortably handle
**prose, headings, lists, links, callouts, citations, and new pages**; the widgets stay
developer territory. Property of the stack, not the tool.

---

## 1. How it works

```
Editor (Google @vt.edu + linked GitHub + repo collaborator)
   /wiki/edit?slug=…   or   /wiki/new
        │ edits prose / fills a scaffolding form
        ▼
   browser reads master MDX (GitHub Contents API) → edits → "Open PR"
        │  their own token: branch → commit → PR   (same-repo, NO fork)
        ▼
   real PR on CoffeePoweredComputers/ascend3-lab-site, authored by THEM
        │  CI `astro build` gate + native GitHub review
        ▼
   admin merges  →  site rebuilds
```

Everything runs in the editor's browser with their GitHub token (the same
`linkWithPopup`/`public_repo` flow `github.ts` already uses for issue-filing). Because an
editor is an upstream **collaborator**, we push a branch **directly to the repo** — the exact
`pr.ts` flow the admin would have used, minus all fork complexity.

---

## 2. Roles & access — three gates, GitHub is the real one

1. **Approved member** (existing): Google `@vt.edu`, `members/{uid}.status == 'member'`.
2. **GitHub linked** (existing mechanism): the member links GitHub via the popup → a
   `public_repo` token in tab memory.
3. **Repo access = the real gate**: the member is a **GitHub collaborator** on the repo, and
   `master` has **branch protection** (require PR to land; block direct pushes to master).

Enforcement is **GitHub's own permission system**, not Firestore. A non-collaborator's token
simply gets a 403 when it tries to push — so the worst case is a clear "ask an admin for repo
access" message, never an unauthorized write. That means the "editor" concept doesn't even
need a Firestore flag; see the gate decision in §7.

**"Making someone an editor" = adding them as a GitHub collaborator** (one action, on GitHub).
Optionally mirror it with an in-app hint, but GitHub is the source of truth.

---

## 3. The PR mechanism (`src/lib/annotate/pr.ts`)

Same-repo Git Data flow, run with the **current user's** token:

- `readFileFromMaster(path)` → `GET /repos/{repo}/contents/{path}?ref=master` → `{ text, sha }`
  (sha = `baseSha` for drift detection).
- `openWikiPullRequest({ files, title, body, branch })`:
  1. `GET /git/ref/heads/master` → base commit; `GET /git/commits/{sha}` → base tree.
  2. If `moduleEntry`: read `wiki-modules.json` **live from master**, insert sorted by `order`,
     **dedup slugs**, re-serialize (2-space + trailing newline).
  3. `POST /git/trees` (raw utf-8 content) → `POST /git/commits` (parents=[base]) →
     `POST /git/refs` (`refs/heads/<branch>`) → `POST /pulls` (`head: <branch>`, `base: master`).
  4. Label `wiki`; return `{ html_url, number }`.
- **Path allowlist (mandatory, defense-in-depth):** only `^src/content/wiki/.+\.mdx$` and the
  single `src/data/wiki-modules.json` are committable — reject anything else even though branch
  protection + PR review is the real gate.
- **Idempotency:** if `<branch>` already exists (double-click / retry), detect and reuse or
  surface the existing PR instead of 422-looping.
- **`baseSha` drift:** re-read the blob sha at open time; warn if it changed since load (GitHub
  will also flag a conflict on the PR — no silent clobber, unlike the dropped queue design).
- Commit **authorship is automatic** — it's the editor's own token, so the PR is genuinely
  theirs (profile link included).

---

## 4. Proposing new content (`/wiki/new`)

- **New lesson** (one file): pick module → title auto-derives a validated
  `^[a-z0-9]+(-[a-z0-9]+)*$` filename slug (non-colliding vs build-time sibling slugs);
  `order` auto = max+1 (editable); optional `group`/`description`/`estMinutes`; **`draft`
  defaults `true`**. → one `.mdx` in the PR; glob loader + sidebar pick it up, no routing edits.
- **New module/section** (atomic multi-file): a module is real only when the JSON entry **and**
  a folder-with-≥1-lesson both exist, so the form requires both — registry entry (unique slug,
  `order` max+1, icon, blurb, **`underConstruction` defaults `true`**) + a mandatory first
  lesson. → single PR: `wiki-modules.json` (live-merged) + the first lesson file.
- **New sub-section**: an in-lesson `##`/`###` heading is just prose (a normal edit); a sidebar
  sub-group is the `group` field — the form warns that grouped lessons need **adjacent `order`**
  values (contiguity) or the group silently splits.

---

## 5. Phases

### Phase 0 — Plumbing (no UI)
- `github.ts`: export `getToken(force?)` + `resetToken()` (factor out of `createGithubIssue`;
  the link/reauth already operates on `currentUser`, so it works for any member, not just admin).
- `links.ts`: export `GITHUB_BRANCH`; add a branch-name helper.
- `frontmatter.ts` (NEW): `parseFrontmatter`/`stringifyFrontmatter` using **`js-yaml`** (a
  hand-rolled `---` splitter corrupts quoted titles, em-dash/`/` in `group`, `: ` in
  descriptions); keep `order`/`estMinutes` numeric; preserve unknown keys.
- `pr.ts` (NEW): `readFileFromMaster` + `openWikiPullRequest` per §3 — **path allowlist,
  idempotency, baseSha drift, wiki-modules live-merge + slug-dedup** all in from day one.
- `wiki.ts`: **Zod-validate `wiki-modules.json`** (today an unchecked `as` cast) so CI can gate
  a malformed/duplicate module entry.
- **Verify:** a dev-only call opens a real one-file PR against master with a collaborator token,
  clean diff, correct authorship.

### Phase 1 — Edit existing → your own PR  ← core deliverable
- `canEditGate`: on the edit entry point, ensure GitHub is linked and (recommended) check
  `GET /repos/{repo}/collaborators/{login}/permission` for push access; else show "ask an admin
  for repo access."
- `src/pages/wiki/edit.astro` (`?slug=`): load master MDX + `baseSha`; typed frontmatter form
  (title/description/order/estMinutes/group/draft; module read-only) + body **textarea**;
  "Open PR" → `openWikiPullRequest` → success toast with the PR link.
- "Edit this page" affordance on lessons (`[...slug].astro`), shown to signed-in members;
  clicking runs the gate.
- Optional "My edits" page: list the editor's open wiki PRs via the GitHub search API.
- **Verify:** an editor edits `qualitative/overview`, opens a PR with exactly that change,
  authored by them; a non-collaborator gets the friendly gate message.

### Phase 2 — Guided scaffolding (new lesson / module / sub-section)
- `src/pages/wiki/new.astro` with mode switch + client-side slug/order/module/group validation
  and `draft:true` / `underConstruction:true` defaults; sibling slugs/orders injected at build.
- **Verify:** new lesson → one `.mdx` PR; new module → single PR (JSON entry + first lesson);
  checkout + `npm run build` compiles and the sidebar shows it.

### Phase 3 — CI build gate + rendered preview
- `.github/workflows/wiki-build-check.yml` on PRs touching `src/content/wiki/**`,
  `wiki-modules.json`, `content.config.ts`, `references.json`: `npm ci` + `npm run build`
  (no Firebase secret needed — build only reads `PUBLIC_FIREBASE_*` client-side).
- **Critical:** a prod build **skips `draft:true` / `underConstruction` bodies** — the exact new
  content the forms produce — so add a **CI-only force-render** step that `render()`s every
  `getCollection('wiki')` entry, or the gate misses new-content MDX compile errors.
- **Free per-PR preview:** add `FirebaseExtended/action-hosting-deploy` (Hosting preview
  channels are free on Spark) so reviewers see the real rendered page, not just a diff.
- **Verify:** a PR with `order: "5"` (string) or missing `title` fails CI; a prose edit passes
  in ~2 min and posts a preview URL.

### Phase 4 — MDXEditor prose upgrade (optional, later)
- `astro add react`; `@mdxeditor/editor` → `vite.optimizeDeps.include`;
  `MdxEditorIsland.tsx` (`client:only="react"`). Frontmatter stays in the typed form (its
  frontmatter plugin stringifies numbers and would break `z.number()`). Descriptors: editable
  for simple string/bool components; **opaque read-only cards** preserving raw MDX for
  expression-prop/data-import ones; `diffSource` + `onError` → source fallback.

---

## 6. One-time GitHub / Firebase setup (yours to do)
- **Firebase Auth → enable the GitHub provider** (already required for the issue-filer; a
  GitHub OAuth App whose callback is the Firebase auth handler).
- **Add each editor as a repo collaborator** (write) on `CoffeePoweredComputers/ascend3-lab-site`.
- **Branch protection on `master`:** require a PR to merge, block direct pushes, and
  (recommended) require the CI check + ≥1 approving review so an editor can't self-merge junk.

---

## 7. Decisions I need

1. **Editor gate** — use the **GitHub-collaborator permission check** as the single source of
   truth (my rec — no Firestore flag to drift), or add a cheap in-app `editor` boolean too?
2. **Branch protection** — require **CI green + 1 approving review** before merge (my rec), so
   editors propose but an admin still approves? Or let trusted editors self-merge?
3. **Draft defaults** — new lessons `draft:true`, new modules `underConstruction:true` (my rec)
   + a **one-click "Publish" PR** (flip the flag) so nothing goes live half-finished and you
   never hand-edit GitHub — want the Publish helper?
4. **"My edits" page** (list your open wiki PRs) — include, or skip for v1?
5. **MDXEditor** — defer to Phase 4, ship the **textarea first** (my rec)?

---

## 8. Edge cases & residual risks (mostly handled by going GitHub-native)

- **Concurrency:** GitHub owns it — overlapping edits surface as PR merge conflicts, no silent
  clobber (a real win over the dropped queue). `baseSha` drift warning is a nice-to-have on top.
- **Non-collaborator tries to edit** → 403 → friendly "ask an admin for repo access." No fork
  path in this model, so a would-be contributor you *don't* want as a collaborator can't
  contribute (accepted tradeoff of editors-only + Option A).
- **Static rebuild latency** — merge → rebuild, not instant publish. Set expectations in the UI.
- **CI gate scope (honest):** `astro build` does **not** fail on a broken `<Cite id>` (renders a
  placeholder) or a dead internal `/wiki/…` link — add lint for those later.
- **Mid-insertion `order`** appends (max+1); inserting between siblings needs a fractional order
  or a renumber — the form warns, doesn't auto-renumber.
- **`<Cite>` to a new source** needs `src/data/references.json` (outside the collection) — not
  covered by v1 forms; warn authors.
- **Out of v1:** deletions, renames, module reordering, image/asset upload, new references —
  the forms must explicitly refuse these, not silently allow a malformed attempt.
- **Prose-only ceiling** (§0) is permanent for interactive lessons.

---

## 9. File-by-file

**New:** `src/lib/annotate/pr.ts`, `frontmatter.ts`; `src/pages/wiki/edit.astro`, `new.astro`;
`.github/workflows/wiki-build-check.yml`; (optional) a "my edits" page; (Phase 4)
`src/components/wiki/MdxEditorIsland.tsx`, `src/lib/annotate/mdx-descriptors.ts`.

**Modified:** `github.ts` (export token helpers), `links.ts` (export branch + namer),
`wiki.ts` (Zod-validate modules; inject sibling slugs/orders), `[...slug].astro`
(+"Edit this page" gate), `wiki.css` (edit/new form styles), `astro.config.mjs` (Phase 4),
`README.md` / `FIREBASE_SETUP.md` (document editor onboarding + branch protection).

**Dropped vs the queue plan:** the `proposals` Firestore collection, its rules block + indexes,
`proposals.ts`, the admin PR-bridge, the review "Proposals" tab, and `my-proposals.astro`.

**Effort:** Phase 0 ≈ 1–1.5 days; Phase 1 (edit-existing → own PR, end-to-end) ≈ 1.5–2 days;
Phase 2 scaffolding ≈ 2 days; Phase 3 CI + preview ≈ 1 day; Phase 4 optional. Meaningfully
less than the queue version.
