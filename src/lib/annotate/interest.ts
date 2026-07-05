/**
 * Firestore data layer for "Express interest" — the undergrad research panels'
 * single call to action. Submissions live in a top-level `interest` collection
 * and always route to the admin Interest tab (see review.astro), regardless of
 * which mentor a project lists — the PI triages and forwards from there.
 *
 * Access is enforced by firestore.rules; this module assumes the caller is an
 * approved member (create) or admin (status change). Import it dynamically so
 * firebase/firestore stays out of the reader bundle until someone acts.
 */
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { getDb } from './firebase';
import type { Interest, InterestStatus } from './types';

const COLLECTION = 'interest';

export interface NewInterest {
  projectSlug: string;
  projectTitle: string;
  note: string;
  author: { uid: string; email: string; name: string };
}

/** Submit interest in a project (status 'new'). Fields must satisfy the create rule. */
export async function submitInterest(r: NewInterest): Promise<string> {
  const ref = await addDoc(collection(getDb(), COLLECTION), {
    projectSlug: r.projectSlug,
    projectTitle: r.projectTitle,
    note: r.note.trim(),
    status: 'new',
    authorUid: r.author.uid,
    authorEmail: r.author.email,
    authorName: r.author.name,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

function toInterest(d: QueryDocumentSnapshot<DocumentData>): Interest {
  return { id: d.id, ...(d.data() as Omit<Interest, 'id'>) };
}

/** Live-subscribe to all submissions (admin Interest tab; newest first). */
export function watchAllInterest(
  cb: (items: Interest[]) => void,
  onError?: (e: Error) => void,
): () => void {
  const q = query(collection(getDb(), COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => cb(snap.docs.map(toInterest)), onError);
}

/** Admin: move a submission through new → contacted → closed. */
export function setInterestStatus(id: string, status: InterestStatus): Promise<void> {
  return updateDoc(doc(getDb(), COLLECTION, id), { status });
}
