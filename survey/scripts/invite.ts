/**
 * Print a guest invite link for a pilot survey (see src/auth/guest.ts).
 *
 *   npm run invite -- pilot        → link valid for 30 days
 *   npm run invite -- pilot 7      → link valid for 7 days
 *
 * One link serves everyone you send it to: each person who opens it is given a
 * fresh `guest:<random>` identity, so their transcripts stay separate. Refuses
 * any survey whose file does not set `eligibility.guestAccess`.
 */
import { inviteUrl } from '../src/auth/guest.js';
import { loadSurveyDir } from '../src/config/load.js';
import { loadEnv } from '../src/env.js';

const [surveyId, daysArg] = process.argv.slice(2);
if (!surveyId) {
  console.error('usage: npm run invite -- <surveyId> [days]');
  process.exit(1);
}
const days = Number(daysArg ?? 30);
if (!Number.isFinite(days) || days <= 0) {
  console.error(`bad day count: ${daysArg}`);
  process.exit(1);
}

try {
  const env = loadEnv();
  const survey = loadSurveyDir('surveys').find((s) => s.config.id === surveyId);
  if (!survey) {
    console.error(`no survey "${surveyId}" in surveys/`);
    process.exit(1);
  }
  if (!survey.config.eligibility.guestAccess) {
    console.error(`survey "${surveyId}" does not allow guests (set eligibility.guestAccess: true — pilots only)`);
    process.exit(1);
  }
  const expires = new Date(Date.now() + days * 86_400_000);
  console.log(inviteUrl(env, surveyId, expires));
  console.log(`\n  survey   ${survey.config.title}`);
  console.log(`  expires  ${expires.toISOString()} (${days} days)`);
  console.log('  note     anyone with this link can take this survey without a VT login');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
