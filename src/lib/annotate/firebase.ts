/**
 * Firebase singleton for the wiki annotation layer.
 *
 * Config comes from PUBLIC_FIREBASE_* env vars (see FIREBASE_SETUP.md). These
 * values are public by design — a Firebase web `apiKey` is a project identifier,
 * not a secret; all access is gated by Firestore security rules. Reading them
 * from env just keeps the exact project out of committed source.
 *
 * The heavy `firebase/*` SDKs (~100 KB gzip) are only pulled in when this module
 * is imported, which callers do via dynamic `import()` — so a logged-out reader
 * who never signs in downloads none of it.
 */
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID,
};

/** True when the required PUBLIC_FIREBASE_* env vars were present at build time. */
export const hasFirebaseConfig = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let app: FirebaseApp | undefined;

/** Lazily initialize (or reuse) the default Firebase app. Guards against the
 *  duplicate-app error that Astro's dev-mode script re-runs can trigger. */
export function getFirebaseApp(): FirebaseApp {
  if (!hasFirebaseConfig) {
    throw new Error(
      'Firebase config missing — set the PUBLIC_FIREBASE_* env vars (see FIREBASE_SETUP.md).',
    );
  }
  if (!app) app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return app;
}

export function getAuthClient(): Auth {
  return getAuth(getFirebaseApp());
}

export function getDb(): Firestore {
  return getFirestore(getFirebaseApp());
}
