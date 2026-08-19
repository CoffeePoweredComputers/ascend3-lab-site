/**
 * Bib checker — in-place edits on raw BibTeX source.
 *
 * The workflow's source of truth is the student's original text; fixes are
 * applied as targeted string edits on an entry's verbatim block (entry.raw,
 * preserved by the parser) so everything untouched keeps its formatting.
 * Never re-serialize from the parsed model.
 */
import type { LintIssue } from './types';

/** Value forms a field can take: {braced, one nesting level}, "quoted", bare. */
const valuePattern = '(?:\\{(?:[^{}]|\\{[^{}]*\\})*\\}|"[^"]*"|[^,{}\\s]+)';

const fieldRe = (name: string) =>
  new RegExp(`(\\b${name}\\s*=\\s*)${valuePattern}`, 'i');

/** Replace an existing `name = …` value, or insert the field before the
 * entry's closing brace. Returns the new raw block. */
export function setField(rawEntry: string, name: string, value: string): string {
  const re = fieldRe(name);
  if (re.test(rawEntry)) return rawEntry.replace(re, `$1{${value}}`);

  const close = rawEntry.lastIndexOf('}');
  if (close === -1) return rawEntry;
  let head = rawEntry.slice(0, close).replace(/\s+$/, '');
  if (!head.endsWith(',') && !head.endsWith('{')) head += ',';
  return `${head}\n  ${name} = {${value}},\n${rawEntry.slice(close)}`;
}

/** Remove a field: its indentation, value, trailing comma, and its own
 * newline — so the surrounding lines close up cleanly whether the field was
 * mid-entry or last. */
export function removeField(rawEntry: string, name: string): string {
  const re = new RegExp(`[ \\t]*\\b${name}\\s*=\\s*${valuePattern}\\s*,?[ \\t]*\\r?\\n?`, 'i');
  return rawEntry.replace(re, '');
}

/** Splice a modified entry block into the source. First occurrence wins if
 * the identical block appears twice (only possible with fully duplicate
 * entries, which lint already flags). */
export function replaceEntryBlock(source: string, oldRaw: string, newRaw: string): string {
  const idx = source.indexOf(oldRaw);
  if (idx === -1) throw new Error('entry not found in source — it may have been edited elsewhere');
  return source.slice(0, idx) + newRaw + source.slice(idx + oldRaw.length);
}

/** Delete an entry block, collapsing the blank line it leaves behind. */
export function removeEntryBlock(source: string, rawEntry: string): string {
  const idx = source.indexOf(rawEntry);
  if (idx === -1) throw new Error('entry not found in source — it may have been edited elsewhere');
  let end = idx + rawEntry.length;
  const after = /^[ \t]*\r?\n(?:[ \t]*\r?\n)*/.exec(source.slice(end));
  if (after) end += after[0].length;
  return source.slice(0, idx) + source.slice(end);
}

/**
 * Apply one mechanical lint fix to a raw block: `fix`-bearing issues rewrite
 * the field, junk fields get deleted. Returns the new raw, or null when the
 * issue isn't mechanically fixable.
 */
export function applyLintFix(rawEntry: string, issue: LintIssue): string | null {
  if (issue.code === 'junk-field' && issue.field) return removeField(rawEntry, issue.field);
  if (issue.fix && issue.field) return setField(rawEntry, issue.field, issue.fix);
  return null;
}
