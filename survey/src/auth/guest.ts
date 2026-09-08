/**
 * Guest access for pilot surveys — a signed invite link for testers who have no
 * VT account.
 *
 * This is the only way into the service that is not VT single sign-on, so it is
 * deliberately narrow on three independent axes:
 *
 *   - A guest identity is `guest:<random>`. PIDs match /^[a-z0-9][a-z0-9._-]*$/
 *     (see config/schema.ts), which admits no colon, so a guest identity cannot
 *     collide with a real PID and cannot appear in a survey's `roles` — it is
 *     structurally incapable of holding researcher or keyholder.
 *   - The token is HMAC'd over the survey id, so an invite to one survey is not
 *     an invite to another, and forging one needs SESSION_SECRET.
 *   - It is refused unless that survey's file sets `eligibility.guestAccess`.
 *     Real studies leave it false, so IRB surveys stay CAS-only.
 *
 * Guests are for piloting an instrument. Nothing here should ever be enabled on
 * a survey collecting research data.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from '../env.js';

const PREFIX = 'guest:';
const VERSION = 'g1';

export function isGuest(pid: string): boolean {
  return pid.startsWith(PREFIX);
}

/** A fresh, unguessable guest identity. Each person who opens the link gets one. */
export function newGuestPid(): string {
  return PREFIX + randomBytes(6).toString('hex');
}

function sign(env: Env, body: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
}

/** Token shape: `g1.<surveyId>.<expiry unix seconds>.<hmac>` */
export function mintInvite(env: Env, surveyId: string, expiresAt: Date): string {
  const body = `${VERSION}.${surveyId}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${body}.${sign(env, body)}`;
}

export function inviteUrl(env: Env, surveyId: string, expiresAt: Date): string {
  return `${env.BASE_URL}/auth/invite?t=${encodeURIComponent(mintInvite(env, surveyId, expiresAt))}`;
}

/** The survey id this token is good for, or null if malformed, forged or expired. */
export function verifyInvite(env: Env, token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, surveyId, exp, mac] = parts as [string, string, string, string];
  if (version !== VERSION) return null;
  const given = Buffer.from(mac);
  const want = Buffer.from(sign(env, `${version}.${surveyId}.${exp}`));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const seconds = Number(exp);
  if (!Number.isFinite(seconds) || seconds * 1000 < Date.now()) return null;
  return surveyId;
}
