/**
 * Client-side GitHub issue creation, authorized through Firebase Auth's GitHub
 * provider.
 *
 * The trick: Firebase brokers the OAuth handshake on its servers (it holds the
 * GitHub OAuth *client secret*, not our public bundle) and hands this browser a
 * GitHub access token. We then POST the issue straight to the CORS-enabled REST
 * API. No server, no Cloud Function, no stored secret — the token lives only in
 * this tab's memory. Only admins ever reach this (the review dashboard gates it).
 *
 * We LINK GitHub to the already-signed-in Firebase user (or reauthenticate if
 * already linked) rather than signInWithPopup — that would swap the Firebase uid
 * to the GitHub identity and detach their members/{uid} record.
 */
import {
  GithubAuthProvider,
  linkWithPopup,
  reauthenticateWithPopup,
} from 'firebase/auth';
import { getAuthClient } from './firebase';
import { GITHUB_REPO } from './links';

// Repo is public, so this is the narrowest scope that can open issues.
const SCOPE = 'public_repo';

let cachedToken: string | null = null;

async function mintToken(): Promise<string> {
  const user = getAuthClient().currentUser;
  if (!user) throw new Error('Sign in first.');
  const provider = new GithubAuthProvider();
  provider.addScope(SCOPE);
  const linked = user.providerData.some((p) => p.providerId === 'github.com');

  let result;
  try {
    result = linked
      ? await reauthenticateWithPopup(user, provider)
      : await linkWithPopup(user, provider);
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'auth/provider-already-linked') {
      result = await reauthenticateWithPopup(user, provider);
    } else if (code === 'auth/credential-already-in-use') {
      throw new Error('That GitHub account is already linked to a different login here.');
    } else if (code === 'auth/operation-not-allowed') {
      throw new Error("GitHub sign-in isn't enabled in Firebase yet — see FIREBASE_SETUP.md.");
    } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new Error('GitHub authorization was cancelled.');
    } else {
      throw e;
    }
  }

  const token = GithubAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) throw new Error('GitHub did not return an access token.');
  return token;
}

export async function getToken(force = false): Promise<string> {
  if (!force && cachedToken) return cachedToken;
  cachedToken = await mintToken();
  return cachedToken;
}

/** Drop the cached token — call before a forced re-mint after a 401. */
export function resetToken(): void {
  cachedToken = null;
}

export interface CreatedIssue {
  url: string;
  number: number;
}

/** Open a GitHub issue from prepared content. Re-mints the token once on 401. */
export async function createGithubIssue(content: {
  title: string;
  body: string;
  labels: string[];
}): Promise<CreatedIssue> {
  const post = (token: string) =>
    fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(content),
    });

  let res = await post(await getToken());
  if (res.status === 401) {
    cachedToken = null;
    res = await post(await getToken(true));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 160) || res.statusText}`);
  }
  const data = await res.json();
  return { url: data.html_url as string, number: data.number as number };
}

/**
 * Whether a GitHub issue number still exists. Unauthenticated (the repo is
 * public), so no token/popup. Returns false ONLY on a definitive 404 — the
 * issue was deleted — so a stale link can be re-filed. On any transient error
 * (network, rate-limit) it returns true, so a blip never spawns a duplicate.
 */
export async function githubIssueExists(number: number): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${number}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    return res.status !== 404;
  } catch {
    return true;
  }
}
