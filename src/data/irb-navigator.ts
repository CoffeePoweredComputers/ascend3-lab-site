/**
 * Data for the VT IRB Pathfinder (see IRBNavigator.astro).
 *
 * A flat node graph: question nodes branch to other nodes; outcome nodes are
 * terminal and carry a determination badge plus the exact VT HRPP resources a
 * researcher needs for that path. Scoped to social/behavioral/computing
 * research only — no biomedical/animal/biosafety branches.
 *
 * Every resource link resolves to a SPECIFIC HRPP document or page, sourced
 * once from ./vt-hrpp-links.json (the single source of truth — do not hard-code
 * URLs here). Those deep .docx/.doc URLs can rot when VT reorganizes the HRPP
 * site, so run `npm run check:irb-links` to verify they all still resolve. This
 * is decision SUPPORT — only HRPP can officially classify a study.
 */
import hrppLinksData from './vt-hrpp-links.json';

export type NavLink = { title: string; url: string; note?: string };

const L = hrppLinksData as Record<string, NavLink>;

export type NavNode =
  | { text: string; options: { label: string; to: string }[] }
  | {
      badge: string;
      tone: 'neutral' | 'good' | 'warn' | 'alert';
      summary: string;
      links: NavLink[];
    };

// ── Shared resources (each aliases one entry in the HRPP link registry) ──────
const TRAINING = L.training;
const PORTAL = L.portal;
const CONTACT = L.contact;
const FAQ = L.faq;
const DETERMINATION = L.determination;
const EXEMPT_TOOL = L.exemptTool;
const PROTOCOL_503 = L.protocol503;
const PROTOCOL_503A = L.protocol503a;
const CONSENT_SBE = L.consentSbe;
const INFO_SHEET = L.infoSheet;
const EXISTING_DATA = L.existingData;
const PARENT_PERMISSION = L.parentPermission;
const ASSENT = L.assent;
const FERPA = L.ferpa;
const POLICY = L.policy;

// CITI + portal + contact — every "needs submission" outcome shares these.
const SUBMIT_TRIO: NavLink[] = [TRAINING, PORTAL, CONTACT];

export const irbNavStart = 'q1';

export const irbNavNodes: Record<string, NavNode> = {
  // ── Questions ──────────────────────────────────────────────────────────
  q1: {
    text: 'Will this project create generalizable knowledge — do you intend to publish, present, or is it a thesis/dissertation?',
    options: [
      { label: 'Yes — or it is a thesis/dissertation', to: 'q2' },
      { label: 'No — class assignment, internal QI, or formative product testing only', to: 'r-nhsr' },
    ],
  },
  q2: {
    text: 'Does it involve living people — through interaction/intervention with them, or their identifiable private information?',
    options: [
      { label: 'Yes', to: 'q3' },
      { label: 'No — only public, aggregate, or anonymous info about no specific individuals', to: 'r-nhsr' },
    ],
  },
  q3: {
    text: 'Are you collecting new data from people, or analyzing data that already exists?',
    options: [
      { label: 'Collecting new data', to: 'q4' },
      { label: 'Using existing data or records', to: 'q3b' },
    ],
  },
  q3b: {
    text: 'Is that existing dataset publicly available, OR fully de-identified with no way for you to re-identify it?',
    options: [
      { label: 'Yes — public or fully de-identified', to: 'r-exempt4' },
      { label: 'No — it is identifiable (e.g. VT student records, logs tied to people)', to: 'r-secondary-identifiable' },
    ],
  },
  q4: {
    text: 'Will participants include any minors (under 18), prisoners, or your own students whose grades you control?',
    options: [
      { label: 'Yes, one or more of these', to: 'r-review-special' },
      { label: 'No — competent adults with no power relationship', to: 'q5' },
    ],
  },
  q5: {
    text: 'What will you actually do with participants?',
    options: [
      { label: 'Only surveys, interviews, focus groups, educational tests, or observe public behavior', to: 'q6' },
      { label: 'A brief, harmless ("benign") behavioral task with adults (a game, puzzle, simple online task)', to: 'q-deception' },
      { label: 'More than that — physiological measures, sensitive intervention, anything that could distress people', to: 'r-fullboard' },
    ],
  },
  'q-deception': {
    text: 'Does the task involve deception or withholding information about the study’s real purpose?',
    options: [
      { label: 'No', to: 'q6' },
      { label: 'Yes', to: 'r-review-deception' },
    ],
  },
  q6: {
    text: 'Could disclosure of participants’ responses realistically harm them (criminal/civil liability, financial or job harm, reputation), or are the topics sensitive (illegal behavior, mental health, etc.)?',
    options: [
      { label: 'No — low-risk topics', to: 'q7' },
      { label: 'Yes — could harm them or sensitive topics', to: 'q6b' },
    ],
  },
  q6b: {
    text: 'Will responses be recorded with identifiers — names, audio/video, IP addresses, or links to accounts?',
    options: [
      { label: 'No — anonymous / not identifiable', to: 'r-expedited' },
      { label: 'Yes — identifiable', to: 'r-fullboard' },
    ],
  },
  q7: {
    text: 'Will you record any identifiers — names, audio/video, IP addresses, or links to accounts?',
    options: [
      { label: 'No — fully anonymous', to: 'r-exempt2' },
      { label: 'Yes — identifiable, but low-risk', to: 'r-exempt2-limited' },
    ],
  },

  // ── Outcomes ───────────────────────────────────────────────────────────
  'r-nhsr': {
    badge: 'Likely Not Human Subjects Research',
    tone: 'neutral',
    summary:
      'This probably falls outside the federal definition of human-subjects research. But you do not get to decide that yourself — file a determination so you have it in writing. Note: senior theses and dissertations always need IRB review.',
    links: [DETERMINATION, FAQ, CONTACT],
  },
  'r-exempt2': {
    badge: 'Likely Exempt — Category 2',
    tone: 'good',
    summary:
      'Anonymous surveys/interviews/observation of low-risk topics typically qualify for an exempt category. You still file for the exemption — only an HRPP coordinator can grant it.',
    links: [EXEMPT_TOOL, PROTOCOL_503A, INFO_SHEET, ...SUBMIT_TRIO],
  },
  'r-exempt2-limited': {
    badge: 'Likely Exempt — Limited IRB Review',
    tone: 'good',
    summary:
      'Because responses are identifiable (even if low-risk), this may qualify as exempt with "limited IRB review" — the IRB checks your data-security and confidentiality safeguards. Describe how identifiers are stored and protected.',
    links: [EXEMPT_TOOL, PROTOCOL_503A, CONSENT_SBE, ...SUBMIT_TRIO],
  },
  'r-exempt4': {
    badge: 'Likely Exempt — Category 4 (existing data)',
    tone: 'good',
    summary:
      'Secondary analysis of public or fully de-identified data generally qualifies for an exempt category and does not need the original participants’ consent. File for the exemption determination.',
    links: [EXISTING_DATA, EXEMPT_TOOL, DETERMINATION, ...SUBMIT_TRIO],
  },
  'r-secondary-identifiable': {
    badge: 'Review needed — identifiable existing data',
    tone: 'warn',
    summary:
      'Using identifiable existing data (e.g. VT student records or logs tied to people) usually means limited or expedited review, and may require a waiver of consent. If it touches education records, FERPA and the Registrar are involved.',
    links: [EXISTING_DATA, FERPA, ...SUBMIT_TRIO],
  },
  'r-expedited': {
    badge: 'Expedited Review',
    tone: 'warn',
    summary:
      'Minimal-risk research that does not fit an exempt category is reviewed by a single IRB member ("expedited"). There is no submission deadline, but allow a few weeks. Start your protocol early.',
    links: [PROTOCOL_503, CONSENT_SBE, ...SUBMIT_TRIO],
  },
  'r-review-special': {
    badge: 'Expedited or Full Board — special population',
    tone: 'warn',
    summary:
      'Minors, prisoners, or your own graded students add protections. Minors cannot use the survey/interview exemption and need parent permission plus child assent; studying your own students raises coercion concerns. Contact HRPP early to confirm the path.',
    links: [PROTOCOL_503, CONSENT_SBE, PARENT_PERMISSION, ASSENT, FERPA, ...SUBMIT_TRIO],
  },
  'r-fullboard': {
    badge: 'Full Board Review',
    tone: 'alert',
    summary:
      'Greater-than-minimal risk, or sensitive identifiable data, goes to the convened IRB. The board meets monthly, so mind the deadlines and start well ahead of your planned start date.',
    links: [PROTOCOL_503, CONSENT_SBE, POLICY, ...SUBMIT_TRIO],
  },
  'r-review-deception': {
    badge: 'Expedited or Full Board — deception',
    tone: 'warn',
    summary:
      'Deception is allowed only if the study is minimal risk, you debrief participants afterward, and (for benign tasks) participants agree up front that some information may be withheld. If full disclosure would change whether someone consents, expect full-board review.',
    links: [PROTOCOL_503, CONSENT_SBE, ...SUBMIT_TRIO],
  },
};
