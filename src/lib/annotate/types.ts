/** Shared types for the wiki annotation + review layer. */
import type { Timestamp } from 'firebase/firestore';

export type MemberRole = 'member' | 'admin';
/** `pending` = signed in but not yet approved by an admin. */
export type MemberStatus = 'pending' | 'member';
/** Self-reported academic level. Informational only — never a permission gate;
 *  used to tailor what's shown (e.g. the undergrad research panels). */
export type MemberLevel = 'undergraduate' | 'graduate' | 'other';

export interface Member {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: MemberRole;
  status: MemberStatus;
  /** Admin-granted flag: shows the in-app editor UI. The REAL write gate is
   *  GitHub collaborator access, not this flag (see WIKI_EDITING_PLAN.md). */
  editor?: boolean;
  /** Self-selected academic level; a member may set or change it anytime via
   *  `setMyLevel` (see firestore.rules — self-update is restricted to this
   *  single field). */
  level?: MemberLevel;
  createdAt: Timestamp | null;
}

export type AnnotationType = 'error' | 'unclear' | 'improvement' | 'review';
export type AnnotationStatus = 'open' | 'in-review' | 'resolved' | 'wontfix';

/**
 * An annotation anchors to content one of two ways:
 *
 *  - `TextSelector` (prose) — a Hypothesis-style text span resolved against the
 *    `.wiki-annotatable` root. `start`/`end` are the fast path; `quote`/`prefix`/
 *    `suffix` let re-anchoring survive edits to surrounding content.
 *  - `BlockSelector` (interactive widgets) — the whole widget as a unit. Its
 *    inner DOM is rewritten by its own script, so it can't hold a stable text
 *    anchor; we point at the component by a stable id instead.
 */
export interface TextSelector {
  kind: 'text';
  quote: string;   // exact selected text
  prefix: string;  // up to ~32 chars before the quote
  suffix: string;  // up to ~32 chars after the quote
  start: number;   // char offset of quote start in the root's raw text
  end: number;     // char offset of quote end
}

export interface BlockSelector {
  kind: 'block';
  blockId: string; // stable id of a whole widget, e.g. "wiki-kappa-0"
  label: string;   // friendly name, e.g. "Kappa calculator"
}

export type Selector = TextSelector | BlockSelector;

export interface Annotation {
  id: string;
  lessonSlug: string;   // == lesson.id, e.g. "qualitative/inter-rater-reliability"
  sourcePath: string;   // "src/content/wiki/<slug>.mdx"
  type: AnnotationType;
  status: AnnotationStatus;
  selector: Selector;
  note: string;
  authorUid: string;
  authorEmail: string;
  authorName: string;   // denormalized so the panel renders without a members read
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  resolvedBy?: string;          // admin uid who set the final status
  resolvedAt?: Timestamp | null;
  resolutionUrl?: string;       // PR/commit that closed it — shown in "My reports"
  resolutionNote?: string;      // optional admin note on resolution
  issueUrl?: string;            // GitHub issue auto-filed when admin set 'in-review'
  issueNumber?: number;         // its number, for a compact "#42" label
  orphaned?: boolean;           // advisory: set when re-anchoring failed on last render
}

export interface Reply {
  id: string;
  body: string;
  authorUid: string;
  authorName: string;
  createdAt: Timestamp | null;
}

/** "Express interest" submission from an undergrad research panel dossier.
 *  `new` → admin hasn't triaged yet; `contacted` → PI/mentor has reached out;
 *  `closed` → done (filled, student withdrew, etc). Routes to the admin
 *  Interest tab regardless of the project's listed mentor — see undergrad.ts. */
export type InterestStatus = 'new' | 'contacted' | 'closed';

export interface Interest {
  id: string;
  projectSlug: string;
  projectTitle: string; // denormalized so the dashboard list needs no join
  note: string;
  status: InterestStatus;
  authorUid: string;
  authorEmail: string;
  authorName: string;
  createdAt: Timestamp | null;
}
