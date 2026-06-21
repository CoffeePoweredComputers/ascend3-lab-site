/**
 * Data for the VT IRB Pathfinder (see IRBNavigator.astro).
 *
 * A flat node graph: question nodes branch to other nodes; outcome nodes are
 * terminal and carry a determination badge plus the exact VT HRPP resources a
 * researcher needs for that path. Scoped to social/behavioral/computing
 * research only — no biomedical/animal/biosafety branches.
 *
 * Links point at stable HRPP landing/index pages (deep .docx URLs rot); the
 * specific template to grab is named in each link's `note`. All URLs were
 * verified to resolve. This is decision SUPPORT — only HRPP can officially
 * classify a study.
 */

export type NavLink = { title: string; url: string; note?: string };

export type NavNode =
  | { text: string; options: { label: string; to: string }[] }
  | {
      badge: string;
      tone: 'neutral' | 'good' | 'warn' | 'alert';
      summary: string;
      links: NavLink[];
    };

// ── Shared resources (defined once, composed into outcomes) ──────────────────
const TRAINING: NavLink = {
  title: 'CITI "Basic Social & Behavioral Research" training',
  url: 'https://www.research.vt.edu/sirc/hrpp/training.html',
  note: 'Required for everyone listed on the protocol, including students. Do this before you submit.',
};
const PORTAL: NavLink = {
  title: 'Submit in the IRB Protocol Management system',
  url: 'https://secure.research.vt.edu/irb/',
  note: 'VT login required — every submission goes through this portal.',
};
const CONTACT: NavLink = {
  title: 'HRPP office — questions & consultations',
  url: 'https://www.research.vt.edu/sirc/hrpp/contacts.html',
  note: 'irb@vt.edu · 540-231-3732 · virtual office hours are listed on the HRPP site.',
};
const FAQ: NavLink = {
  title: 'Getting Started — Common Questions',
  url: 'https://www.research.vt.edu/sirc/hrpp/getting-started-common-questions.html',
};
const DETERMINATION: NavLink = {
  title: 'Human Subjects Research Determination Form',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'On the Templates page — file this to get an official "not human subjects research" letter.',
};
const EXEMPT_TOOL: NavLink = {
  title: 'Exempt Assessment Tool & Protocol Builder',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'On the Templates page — walks you through whether an exempt category fits.',
};
const PROTOCOL_503: NavLink = {
  title: 'HRP-503 Human Research Protocol template',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'The standard protocol template, on the Templates page.',
};
const PROTOCOL_503A: NavLink = {
  title: 'HRP-503a Survey Research Protocol template',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'For surveys, questionnaires, interviews, and focus groups.',
};
const CONSENT_SBE: NavLink = {
  title: 'HRP-502 Social/Behavioral Informed Consent template',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'Use the social/behavioral version — not the biomedical one.',
};
const INFO_SHEET: NavLink = {
  title: 'Information Sheet for Studies Without Consent',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'For anonymous/online studies where documentation of consent is waived.',
};
const EXISTING_DATA: NavLink = {
  title: 'Existing Data Protocol template',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'For secondary analysis of data that was already collected.',
};
const PARENT_PERMISSION: NavLink = {
  title: 'Parent Permission & Assent templates',
  url: 'https://www.research.vt.edu/sirc/hrpp/resources/templates.html',
  note: 'HRP-502p and the assent templates — required when participants are minors.',
};
const FERPA: NavLink = {
  title: 'Forms & Guidance (FERPA, SOPs, checklists)',
  url: 'https://www.research.vt.edu/research-support/forms-guidance/hrpp.html',
  note: 'Using VT student education records usually needs Registrar permission and may need consent.',
};
const POLICY: NavLink = {
  title: 'VT Policy 13040 — Human Subjects Research',
  url: 'https://policies.vt.edu/13040.pdf',
  note: 'Full-board submission deadlines tie to the monthly meeting schedule.',
};

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
    links: [PROTOCOL_503, CONSENT_SBE, PARENT_PERMISSION, FERPA, ...SUBMIT_TRIO],
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
