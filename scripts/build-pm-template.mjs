#!/usr/bin/env node
/**
 * Build the "Project Management for Research" planning-sheet template.
 *
 * Generates public/templates/pm-research-tracker.xlsx with three tabs:
 *   1. Structured Abstract — the one-paragraph plan (impact-if-positive/negative).
 *   2. Timeline — an NSF-style, color-coded Gantt (filled example + blank template + legend).
 *   3. Status Tracking — a WIP-limited board + a weekly/1:1 log.
 *
 * This script is the SOURCE OF TRUTH for the template; the .xlsx it emits is a build
 * artifact committed to the repo (served at /templates/…) and the seed for the shared
 * Google Sheet students copy. Regenerate + recommit after any change here.
 *
 *   npm run build:pm-template
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/templates');
const outFile = join(outDir, 'pm-research-tracker.xlsx');

// ── Palette (ARGB) ───────────────────────────────────────────────────────────
const C = {
  band: 'FF16A34A', // green header band = student-owned
  bandText: 'FFFFFFFF',
  head: 'FF1E293B', // slate column headers
  headText: 'FFFFFFFF',
  group: 'FFE2E8F0', // aim / section group rows
  example: 'FFF8FAFC', // example cells
  aim1: 'FF3B82F6', // blue  — setup / IRB
  aim2: 'FF22C55E', // green — data collection
  aim3: 'FFF97316', // orange— analysis
  writing: 'FF9CA3AF', // gray — writing / submission
  buffer: 'FFFDE68A', // amber border cells = buffer
  red: 'FFFECACA', // fragile / blocked
  green: 'FFBBF7D0', // robust / done
  blue: 'FFBFDBFE', // doing
  gray: 'FFE5E7EB', // backlog
};

const thin = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };

/** Green "you own this" banner spanning a1:through of the given row. */
function banner(ws, row, through, text) {
  ws.mergeCells(`A${row}:${through}${row}`);
  const cell = ws.getCell(`A${row}`);
  cell.value = text;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.band } };
  cell.font = { bold: true, size: 12, color: { argb: C.bandText } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(row).height = 24;
}

function headerCell(cell, text) {
  cell.value = text;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } };
  cell.font = { bold: true, color: { argb: C.headText } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
  cell.border = allBorders;
}

function fillCell(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB 1 — Structured Abstract
// ═════════════════════════════════════════════════════════════════════════════
function buildAbstract(wb) {
  const ws = wb.addWorksheet('1 · Structured Abstract', {
    views: [{ state: 'frozen', ySplit: 6 }],
  });
  ws.columns = [
    { width: 34 }, // A section
    { width: 58 }, // B example
    { width: 58 }, // C your entry
  ];

  banner(ws, 1, 'C', 'STRUCTURED ABSTRACT · you own this — write it BEFORE you run the study');
  const meta = [
    ['Owner', 'Dana S.  (example)', '[ your name ]'],
    ['Last updated', '2026-07-14', '[ date ]'],
    ['Version', 'v3', 'v1'],
  ];
  meta.forEach((r, i) => {
    const row = 2 + i;
    ws.getCell(`A${row}`).value = r[0];
    ws.getCell(`A${row}`).font = { bold: true };
    ws.getCell(`B${row}`).value = r[1];
    ws.getCell(`C${row}`).value = r[2];
    fillCell(ws.getCell(`B${row}`), C.example);
    ['A', 'B', 'C'].forEach((col) => (ws.getCell(`${col}${row}`).border = allBorders));
  });

  // Column headers (row 6)
  headerCell(ws.getCell('A6'), 'Section');
  headerCell(ws.getCell('B6'), 'Example — CS1 debugging-prompt study');
  headerCell(ws.getCell('C6'), 'Your entry');

  const rows = [
    ['Title', 'Metacognitive debugging prompts in CS1'],
    [
      'Background & context',
      'CS1 students rarely ask for help while debugging, and when they do it is often too late. Reflective prompts might change that.',
    ],
    [
      'Objective / research question',
      'Does a "what have you already tried?" prompt change how intro-CS students seek help while debugging?',
    ],
    ['Methods — Design', 'Convergent mixed methods: a quasi-experiment across two CS1 sections + follow-up interviews.'],
    ['Methods — Sample & recruitment', '~120 students across two sections; 12 students interviewed (purposive).'],
    ['Methods — Measures / data sources', 'IDE help-request events; 30-min semi-structured interviews.'],
    [
      'Methods — Analysis plan (qual / quant / mixed + integration)',
      'Logistic regression on help-request rate + reflexive thematic analysis of interviews, joined in a joint display. Sequence + integration decided now.',
    ],
    ['Expected contribution  (replaces "Results")', 'A reusable CS1 lab-design guideline about reflective prompts.'],
    ['Impact if results are POSITIVE', 'Prompt raises productive help-seeking → ship the guideline + the prompt wording.'],
    [
      'Impact if results are NEUTRAL or OPPOSITE',
      'No change in the rate — but interviews explain WHY students route around the prompt (reads as a gate, not an offer): a CS-ed contribution + redesign brief.',
    ],
    ['Robust to outcome?  (Y / N)', 'Y'],
    ['Qualitative strand?  (Y / N + method)', 'Y — reflexive thematic analysis'],
    ['Pre-registered / Registered Report?  (link + stage)', 'osf.io/xxxxx  (pre-registered, Stage 1)'],
  ];

  let r = 7;
  const rowIndex = {};
  for (const [label, example] of rows) {
    rowIndex[label.split('  ')[0]] = r;
    const a = ws.getCell(`A${r}`);
    a.value = label;
    a.font = { bold: true };
    a.alignment = { vertical: 'top', wrapText: true };
    const b = ws.getCell(`B${r}`);
    b.value = example;
    b.alignment = { vertical: 'top', wrapText: true };
    fillCell(b, C.example);
    const c = ws.getCell(`C${r}`);
    c.alignment = { vertical: 'top', wrapText: true };
    ['A', 'B', 'C'].forEach((col) => (ws.getCell(`${col}${r}`).border = allBorders));
    // roomier rows for the prose fields
    ws.getRow(r).height = label.startsWith('Background') || label.startsWith('Impact if results are NEUTRAL or OPPOSITE') || label.includes('Analysis plan') ? 56 : 30;
    r += 1;
  }

  // Highlight the two impact branches + the robustness flag.
  const posRow = rowIndex['Impact if results are POSITIVE'];
  const negRow = rowIndex['Impact if results are NEUTRAL or OPPOSITE'];
  const robRow = rowIndex['Robust to outcome?'];
  [posRow, negRow].forEach((rw) => {
    ws.getCell(`A${rw}`).font = { bold: true, color: { argb: 'FF0F766E' } };
  });
  // Example flag is robust → green.
  fillCell(ws.getCell(`B${robRow}`), C.green);
  ws.getCell(`B${robRow}`).alignment = { vertical: 'top', horizontal: 'center' };
  ws.getCell(`C${robRow}`).alignment = { vertical: 'top', horizontal: 'center' };

  // Conditional format on the student's "Robust to outcome?" cell:
  //  green when BOTH impact branches are filled; red when the NEUTRAL-or-OPPOSITE branch is blank.
  ws.addConditionalFormatting({
    ref: `C${robRow}`,
    rules: [
      {
        type: 'expression',
        formulae: [`AND(NOT(ISBLANK($C$${posRow})),NOT(ISBLANK($C$${negRow})))`],
        priority: 1,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.green } } },
      },
      {
        type: 'expression',
        formulae: [`ISBLANK($C$${negRow})`],
        priority: 2,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.red } } },
      },
    ],
  });

  // Guidance note under the table.
  const noteRow = r + 1;
  ws.mergeCells(`A${noteRow}:C${noteRow}`);
  const note = ws.getCell(`A${noteRow}`);
  note.value =
    'How to use this tab: fill column C top-down. If "Impact if results are NEUTRAL or OPPOSITE" is blank, the design is fragile (the flag turns red) — revise the question until a null result still teaches something. Deep guidance: /wiki/project-management/scope';
  note.alignment = { wrapText: true, vertical: 'top' };
  note.font = { italic: true, color: { argb: 'FF475569' } };
  ws.getRow(noteRow).height = 54;
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB 2 — Timeline (NSF-style Gantt)
// ═════════════════════════════════════════════════════════════════════════════
const LABEL_COLS = ['Task / subtask', 'Owner', 'Depends-on', 'Buffer (wks)', 'Type'];
const QN = 8; // 2 years × 4 quarters
const Q_START = LABEL_COLS.length + 1; // first quarter column index (F = 6)

function timelineHeader(ws, top) {
  // Year merge row
  const yearRow = top;
  ws.mergeCells(yearRow, Q_START, yearRow, Q_START + 3);
  ws.mergeCells(yearRow, Q_START + 4, yearRow, Q_START + 7);
  const y1 = ws.getCell(yearRow, Q_START);
  const y2 = ws.getCell(yearRow, Q_START + 4);
  [y1, y2].forEach((c, i) => {
    c.value = `Year ${i + 1}`;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } };
    c.font = { bold: true, color: { argb: C.headText } };
    c.alignment = { horizontal: 'center' };
    c.border = allBorders;
  });
  // Column-label row
  const hr = top + 1;
  LABEL_COLS.forEach((label, i) => headerCell(ws.getCell(hr, 1 + i), label));
  for (let q = 0; q < QN; q++) {
    const cell = ws.getCell(hr, Q_START + q);
    headerCell(cell, `Q${(q % 4) + 1}`);
    cell.alignment = { horizontal: 'center' };
  }
  return hr; // row of the column labels
}

/** Paint a bar across quarter columns [qFrom, qTo] (1-based quarter #, 1..8). */
function bar(ws, row, qFrom, qTo, argb, label) {
  for (let q = qFrom; q <= qTo; q++) {
    const cell = ws.getCell(row, Q_START + (q - 1));
    fillCell(cell, argb);
    cell.border = allBorders;
    if (label && q === qFrom) {
      cell.value = label;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
      cell.alignment = { horizontal: 'left' };
    }
  }
}

/** Place a glyph (◆ milestone / ▲ go-no-go) in a single quarter cell. */
function glyph(ws, row, q, mark) {
  const cell = ws.getCell(row, Q_START + (q - 1));
  cell.value = mark;
  cell.alignment = { horizontal: 'center' };
  cell.font = { bold: true, size: 12 };
  cell.border = allBorders;
}

function labelRow(ws, row, task, owner, dependsOn, buffer, type, isGroup) {
  const vals = [task, owner, dependsOn, buffer, type];
  vals.forEach((v, i) => {
    const cell = ws.getCell(row, 1 + i);
    cell.value = v ?? '';
    cell.border = allBorders;
    cell.alignment = { vertical: 'middle', wrapText: true, indent: i === 0 && !isGroup ? 1 : 0 };
    if (isGroup) {
      fillCell(cell, C.group);
      cell.font = { bold: true };
    }
  });
  // empty quarter cells get borders so the grid reads as a grid
  for (let q = 0; q < QN; q++) {
    const cell = ws.getCell(row, Q_START + q);
    cell.border = allBorders;
    if (isGroup) fillCell(cell, C.group);
  }
}

function buildTimeline(wb) {
  const ws = wb.addWorksheet('2 · Timeline', { views: [{ state: 'frozen', xSplit: 1 }] });
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 11;
  ws.getColumn(5).width = 13;
  for (let q = 0; q < QN; q++) ws.getColumn(Q_START + q).width = 6; // equal-width quarters

  banner(ws, 1, columnLetter(Q_START + QN - 1), 'TIMELINE · plan backward from the deadline; re-plan on a cadence');

  // ── EXAMPLE block ──
  ws.getCell('A3').value = '▼ EXAMPLE — CS1 debugging-prompt study (2-year MS). Build yours in the BLANK template below.';
  ws.getCell('A3').font = { bold: true, color: { argb: 'FF475569' } };
  const exHead = timelineHeader(ws, 4);
  let r = exHead + 1;
  const g = (t) => { labelRow(ws, r, t, '', '', '', '', true); r += 1; };

  g('Aim 1 — Setup & IRB');
  labelRow(ws, r, 'Draft & submit IRB protocol', 'Dana', '—', 2, 'milestone');
  bar(ws, r, 1, 1, C.aim1, 'IRB'); r += 1;
  labelRow(ws, r, '◆ IRB approved', 'IRB', 'protocol', 0, 'milestone');
  glyph(ws, r, 1, '◆'); r += 1;
  labelRow(ws, r, 'Recruit & consent', 'Dana', 'IRB approved', 3, 'milestone');
  bar(ws, r, 2, 3, C.aim1); r += 1;

  g('Aim 2 — Data collection');
  labelRow(ws, r, 'Collect IDE logs + interviews', 'Dana', 'recruiting', 3, 'milestone');
  bar(ws, r, 3, 4, C.aim2); r += 1;
  labelRow(ws, r, '▲ Go/no-go after pilot', 'Team', 'pilot data', 0, 'decision');
  glyph(ws, r, 3, '▲'); r += 1;

  g('Aim 3 — Analysis');
  labelRow(ws, r, 'Analysis (qual + quant) + joint display', 'Dana', 'data complete', 2, 'milestone');
  bar(ws, r, 5, 6, C.aim3); r += 1;

  g('Writing & submission');
  labelRow(ws, r, 'Draft + revise the paper', 'Dana', 'analysis', 3, 'deadline');
  bar(ws, r, 7, 7, C.writing); r += 1;
  labelRow(ws, r, '◆ Conference deadline', '—', 'draft', 0, 'deadline');
  glyph(ws, r, 8, '◆'); r += 1;

  // Legend
  r += 1;
  legend(ws, r); r += 6;

  // ── BLANK template block ──
  r += 1;
  ws.getCell(`A${r}`).value = '▼ BLANK TEMPLATE — fill this in for your project';
  ws.getCell(`A${r}`).font = { bold: true, color: { argb: 'FF475569' } };
  r += 1;
  const blHead = timelineHeader(ws, r);
  r = blHead + 1;
  const blankGroup = (t) => {
    labelRow(ws, r, t, '', '', '', '', true); r += 1;
    for (let k = 0; k < 2; k++) { labelRow(ws, r, '', '', '', '', ''); r += 1; }
  };
  ['Aim 1 — Setup & IRB', 'Aim 2 — Data collection', 'Aim 3 — Analysis', 'Writing & submission'].forEach(blankGroup);
  labelRow(ws, r, 'Milestones (◆) / decisions (▲)', '', '', '', ''); r += 1;

  // Add the same legend under the blank grid for reference.
  r += 1;
  legend(ws, r);
}

function legend(ws, top) {
  ws.getCell(`A${top}`).value = 'Legend';
  ws.getCell(`A${top}`).font = { bold: true };
  const entries = [
    [C.aim1, 'Aim 1 — setup / IRB'],
    [C.aim2, 'Aim 2 — data collection'],
    [C.aim3, 'Aim 3 — analysis'],
    [C.writing, 'Writing & submission'],
  ];
  entries.forEach(([argb, text], i) => {
    const row = top + 1 + i;
    const swatch = ws.getCell(`A${row}`);
    fillCell(swatch, argb);
    swatch.border = allBorders;
    ws.getCell(`B${row}`).value = text;
    ws.mergeCells(`B${row}:E${row}`);
  });
  const gm = top + 5;
  ws.getCell(`A${gm}`).value = '◆ ▲';
  ws.getCell(`A${gm}`).alignment = { horizontal: 'center' };
  ws.getCell(`B${gm}`).value = '◆ = milestone / deliverable   ▲ = go/no-go decision   ·   "Buffer (wks)" column = named buffer per phase';
  ws.mergeCells(`B${gm}:${columnLetter(Q_START + QN - 1)}${gm}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB 3 — Status Tracking
// ═════════════════════════════════════════════════════════════════════════════
function buildStatus(wb) {
  const ws = wb.addWorksheet('3 · Status Tracking', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [40, 14, 12, 40, 30, 30, 34];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  banner(ws, 1, 'G', 'STATUS TRACKING · you own this — update it BEFORE your 1:1');

  // Owner meta
  ws.getCell('A2').value = 'Owner:';
  ws.getCell('A2').font = { bold: true };
  ws.getCell('B2').value = '[ your name ]';
  ws.getCell('C2').value = 'Last updated:';
  ws.getCell('C2').font = { bold: true };
  ws.getCell('D2').value = '[ date ]';

  // ── Section A · Task board ──
  ws.mergeCells('A4:G4');
  const secA = ws.getCell('A4');
  secA.value = 'SECTION A · Task board — WIP limit: keep 2–3 tasks in "Doing"';
  secA.font = { bold: true };
  fillCell(secA, C.group);

  // WIP counter (COUNTIF over the board's Status column, rows 7..16)
  ws.getCell('F5').value = 'In "Doing" now:';
  ws.getCell('F5').font = { bold: true };
  ws.getCell('G5').value = { formula: 'COUNTIF(B7:B16,"Doing")' };
  ws.getCell('G5').alignment = { horizontal: 'center' };
  ws.addConditionalFormatting({
    ref: 'G5',
    rules: [
      {
        type: 'cellIs',
        operator: 'greaterThan',
        formulae: ['3'],
        priority: 1,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.red } } },
      },
    ],
  });

  const boardHead = ['Task', 'Status', 'Priority', 'Definition of Done', 'Blocker'];
  boardHead.forEach((h, i) => headerCell(ws.getCell(6, i + 1), h));

  const boardRows = [
    ['Reproduce Figure 2 pipeline', 'Doing', 'High', 'Script regenerates the figure from raw CSV in one run', 'waiting on cleaned data'],
    ['Code 12 interview transcripts', 'Doing', 'High', 'All transcripts first-cycle coded in the codebook', ''],
    ['Draft methods section', 'Backlog', 'Med', 'Shared with advisor for review', ''],
  ];
  boardRows.forEach((rw, i) => {
    const row = 7 + i;
    rw.forEach((v, ci) => {
      const cell = ws.getCell(row, ci + 1);
      cell.value = v;
      cell.border = allBorders;
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
  // Blank board rows for the student (through row 16, matching the COUNTIF range).
  for (let row = 7 + boardRows.length; row <= 16; row++) {
    for (let ci = 1; ci <= 5; ci++) {
      const cell = ws.getCell(row, ci);
      cell.border = allBorders;
    }
  }

  // Status dropdown + color, Priority dropdown — over the whole board range.
  for (let row = 7; row <= 16; row++) {
    ws.getCell(row, 2).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"Backlog,Doing,Done,Blocked"'],
    };
    ws.getCell(row, 3).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"High,Med,Low"'],
    };
  }
  const statusColor = [
    ['Backlog', C.gray],
    ['Doing', C.blue],
    ['Done', C.green],
    ['Blocked', C.red],
  ];
  statusColor.forEach(([val, argb], i) => {
    ws.addConditionalFormatting({
      ref: 'B7:B16',
      rules: [
        {
          type: 'expression',
          formulae: [`$B7="${val}"`],
          priority: i + 1,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb } } },
        },
      ],
    });
  });

  // ── Section B · Weekly + 1:1 log ──
  const bTop = 18;
  ws.mergeCells(`A${bTop}:G${bTop}`);
  const secB = ws.getCell(`A${bTop}`);
  secB.value = 'SECTION B · Weekly + 1:1 log — write 4 lines every week (Tried / Learned / Decided / Next)';
  secB.font = { bold: true };
  fillCell(secB, C.group);

  const logHead = ['Date', 'Week / Sprint #', 'One-line status', 'Did (since last)', 'Blockers', 'Next actions (owner + due)', 'Advisor decisions'];
  logHead.forEach((h, i) => headerCell(ws.getCell(bTop + 1, i + 1), h));

  const logExample = [
    '2026-07-10', 'Wk 3', 'On track', 'Coded 8 transcripts; drafted methods', 'Recruitment slow (6/12)', 'Email dept listserv by 7/17 (Dana)', 'Extend recruiting 2 wks; start analysis on the pilot set',
  ];
  logExample.forEach((v, i) => {
    const cell = ws.getCell(bTop + 2, i + 1);
    cell.value = v;
    cell.border = allBorders;
    cell.alignment = { vertical: 'top', wrapText: true };
    fillCell(cell, C.example);
  });
  for (let row = bTop + 3; row <= bTop + 12; row++) {
    for (let ci = 1; ci <= 7; ci++) ws.getCell(row, ci).border = allBorders;
  }

  ws.getCell(`A${bTop + 14}`).value =
    'Close the loop: send a 3–6 bullet decision summary within ~24h of each 1:1. Deep guidance: /wiki/project-management/status-tracking';
  ws.mergeCells(`A${bTop + 14}:G${bTop + 14}`);
  ws.getCell(`A${bTop + 14}`).font = { italic: true, color: { argb: 'FF475569' } };
}

// ── util ──────────────────────────────────────────────────────────────────────
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── main ──────────────────────────────────────────────────────────────────────
const wb = new ExcelJS.Workbook();
wb.creator = 'ASCEND Lab — Project Management for Research';
wb.created = new Date(2026, 6, 15);
buildAbstract(wb);
buildTimeline(wb);
buildStatus(wb);
mkdirSync(outDir, { recursive: true });
await wb.xlsx.writeFile(outFile);
console.log(`✓ wrote ${outFile.replace(root + '/', '')} (${wb.worksheets.length} tabs)`);
