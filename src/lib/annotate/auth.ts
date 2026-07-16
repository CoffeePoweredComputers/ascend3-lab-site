/**
 * Auth + membership helpers for the annotation layer.
 *
 * Google sign-in restricted to @vt.edu. The `hd` provider hint is UX only — real
 * enforcement lives in firestore.rules; here we also refuse (and sign out) any
 * non-vt.edu account client-side for a clear message. On first sign-in we create
 * a `pending` member doc; an admin promotes it to `status:'member'` in the
 * review dashboard.
 */
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { getAuthClient, getDb } from './firebase';
import type { Member, MemberLevel } from './types';

/** localStorage flag: set while a session exists so we know to restore Firebase
 *  on the next page load *without* eagerly loading the SDK for logged-out readers. */
export const AUTH_FLAG = 'wiki-auth';

const VT_DOMAIN = '@vt.edu';

function vtProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: 'vt.edu', prompt: 'select_account' });
  return provider;
}

export function isVtEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(VT_DOMAIN);
}

/** Subscribe to auth state; returns an unsubscribe fn. */
export function onUser(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(getAuthClient(), cb);
}

/**
 * Google sign-in. Rejects (and signs out) non-@vt.edu accounts. On success,
 * ensures a member doc exists (creating a `pending` one for new users).
 */
export async function signIn(): Promise<{ user: User; member: Member }> {
  const auth = getAuthClient();
  const cred = await signInWithPopup(auth, vtProvider());
  if (!isVtEmail(cred.user.email)) {
    await fbSignOut(auth);
    throw new Error('Please sign in with your Virginia Tech (@vt.edu) Google account.');
  }
  const member = await ensureMemberDoc(cred.user);
  localStorage.setItem(AUTH_FLAG, '1');
  return { user: cred.user, member };
}

export async function signOut(): Promise<void> {
  localStorage.removeItem(AUTH_FLAG);
  await fbSignOut(getAuthClient());
}

/** Create the member doc on first sign-in; return the existing one otherwise. */
export async function ensureMemberDoc(user: User): Promise<Member> {
  const ref = doc(getDb(), 'members', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return { uid: user.uid, ...(snap.data() as Omit<Member, 'uid'>) };

  // New user: a self-owned, unprivileged, pending record. Fields here must match
  // the `members` create rule in firestore.rules.
  const data: Record<string, unknown> = {
    email: user.email ?? '',
    displayName: user.displayName ?? user.email ?? 'Unknown',
    role: 'member',
    status: 'pending',
    createdAt: serverTimestamp(),
  };
  if (user.photoURL) data.photoURL = user.photoURL; // Firestore rejects `undefined`
  await setDoc(ref, data);

  return {
    uid: user.uid,
    email: data.email as string,
    displayName: data.displayName as string,
    photoURL: user.photoURL ?? undefined,
    role: 'member',
    status: 'pending',
    createdAt: null,
  };
}

/** Read the member doc for a uid (null if none exists). */
export async function getMember(uid: string): Promise<Member | null> {
  const snap = await getDoc(doc(getDb(), 'members', uid));
  return snap.exists() ? { uid, ...(snap.data() as Omit<Member, 'uid'>) } : null;
}

/** Self-service: a member sets or changes their own academic level anytime.
 *  firestore.rules rejects any update that touches other fields or an invalid value. */
export function setMyLevel(uid: string, level: MemberLevel): Promise<void> {
  return updateDoc(doc(getDb(), 'members', uid), { level });
}

export const isApprovedMember = (m: Member | null): boolean => m?.status === 'member';
export const isAdmin = (m: Member | null): boolean =>
  m?.role === 'admin' && m?.status === 'member';
/** May see the in-app editor UI. Admins are implicitly editors. This is a UI
 *  gate only — opening a PR still requires GitHub collaborator access. */
export const isEditor = (m: Member | null): boolean =>
  m?.status === 'member' && (m?.role === 'admin' || m?.editor === true);
