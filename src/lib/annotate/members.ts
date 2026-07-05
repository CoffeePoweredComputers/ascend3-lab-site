/**
 * Admin-only membership management (approve / promote lab members).
 *
 * All of these are gated by firestore.rules to `isAdmin()`. `watchMembers` lists
 * the whole collection — allowed only because the members read rule grants admins
 * access to every doc. Import dynamically to keep firebase out of the reader bundle.
 */
import { collection, doc, onSnapshot, query, orderBy, updateDoc, deleteDoc } from 'firebase/firestore';
import { getDb } from './firebase';
import type { Member, MemberRole } from './types';

export function watchMembers(
  cb: (members: Member[]) => void,
  onError?: (e: Error) => void,
): () => void {
  const q = query(collection(getDb(), 'members'), orderBy('createdAt', 'asc'));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<Member, 'uid'>) }))),
    onError,
  );
}

/** Approve a pending member (status → member). */
export function approveMember(uid: string): Promise<void> {
  return updateDoc(doc(getDb(), 'members', uid), { status: 'member' });
}

/** Deny/remove a member. Note: not a permanent ban — signing in again re-creates
 *  a pending record, which the admin simply doesn't approve. */
export function removeMember(uid: string): Promise<void> {
  return deleteDoc(doc(getDb(), 'members', uid));
}

export function setMemberRole(uid: string, role: MemberRole): Promise<void> {
  return updateDoc(doc(getDb(), 'members', uid), { role });
}

/** Grant/revoke the in-app editor flag (admin-only, per firestore.rules). */
export function setMemberEditor(uid: string, editor: boolean): Promise<void> {
  return updateDoc(doc(getDb(), 'members', uid), { editor });
}
