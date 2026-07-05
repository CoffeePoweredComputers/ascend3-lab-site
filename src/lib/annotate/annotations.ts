/**
 * Firestore data layer for wiki issue-reports.
 *
 * Reports live in the top-level `annotations` collection (the dashboard queries
 * across all lessons; a lesson page filters by lessonSlug). Each carries a FROZEN
 * snapshot of what was reported (the selector's quote + note), so the admin sees
 * the original reference even after the content is edited and the on-page anchor
 * orphans. Orphaning is expected here — this is issue-reporting, not note-taking.
 *
 * Access is enforced by firestore.rules; this module assumes the caller is an
 * approved member (create) or admin (status change). Import it dynamically so
 * firebase/firestore stays out of the reader bundle until someone acts.
 */
import {
  collection,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { getDb } from './firebase';
import { sourcePath } from './links';
import type { Annotation, AnnotationStatus, AnnotationType, Selector } from './types';

const COLLECTION = 'annotations';

export interface NewReport {
  lessonSlug: string;
  type: AnnotationType;
  selector: Selector;
  note: string;
  author: { uid: string; email: string; name: string };
}

/** File a new report (status 'open'). Fields must satisfy the create rule. */
export async function createReport(r: NewReport): Promise<string> {
  const ref = await addDoc(collection(getDb(), COLLECTION), {
    lessonSlug: r.lessonSlug,
    sourcePath: sourcePath(r.lessonSlug),
    type: r.type,
    status: 'open',
    selector: r.selector,
    note: r.note.trim(),
    authorUid: r.author.uid,
    authorEmail: r.author.email,
    authorName: r.author.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

function toAnnotation(d: QueryDocumentSnapshot<DocumentData>): Annotation {
  return { id: d.id, ...(d.data() as Omit<Annotation, 'id'>) };
}

/** Fetch a single report by id (for jump-to-highlight from the dashboard). */
export async function getReport(id: string): Promise<Annotation | null> {
  const snap = await getDoc(doc(getDb(), COLLECTION, id));
  return snap.exists() ? { id: snap.id, ...(snap.data() as Omit<Annotation, 'id'>) } : null;
}

/** Live-subscribe to the current user's own reports (newest first). */
export function watchMyReports(
  uid: string,
  cb: (reports: Annotation[]) => void,
  onError?: (e: Error) => void,
): () => void {
  const q = query(
    collection(getDb(), COLLECTION),
    where('authorUid', '==', uid),
    orderBy('createdAt', 'desc'),
  );
  return onSnapshot(q, (snap) => cb(snap.docs.map(toAnnotation)), onError);
}

/** Live-subscribe to all reports (admin dashboard; newest first). */
export function watchAllReports(
  cb: (reports: Annotation[]) => void,
  onError?: (e: Error) => void,
): () => void {
  const q = query(collection(getDb(), COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => cb(snap.docs.map(toAnnotation)), onError);
}

export interface Resolution {
  resolvedBy?: string;     // admin uid
  resolutionUrl?: string;  // PR/commit that closed it
  resolutionNote?: string;
  issueUrl?: string;       // GitHub issue auto-filed on 'in-review'
  issueNumber?: number;
}

/** Admin: change a report's status, attaching resolution/issue info as given. */
export async function setReportStatus(
  id: string,
  status: AnnotationStatus,
  resolution?: Resolution,
): Promise<void> {
  const patch: Record<string, unknown> = { status, updatedAt: serverTimestamp() };
  if (status === 'resolved' || status === 'wontfix') {
    patch.resolvedAt = serverTimestamp();
    if (resolution?.resolvedBy) patch.resolvedBy = resolution.resolvedBy;
    if (resolution?.resolutionUrl) patch.resolutionUrl = resolution.resolutionUrl;
    if (resolution?.resolutionNote) patch.resolutionNote = resolution.resolutionNote;
  }
  if (resolution?.issueUrl) patch.issueUrl = resolution.issueUrl;
  if (resolution?.issueNumber !== undefined) patch.issueNumber = resolution.issueNumber;
  await updateDoc(doc(getDb(), COLLECTION, id), patch);
}
