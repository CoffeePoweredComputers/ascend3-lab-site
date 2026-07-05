/**
 * A CodeMirror 6 source editor for the wiki edit/new surfaces.
 *
 * This is a nicer SOURCE editor, not a WYSIWYG: it edits the raw MDX string
 * (Markdown syntax highlighting, bracket matching, line wrapping, a small
 * insert-only formatting toolbar) and never re-parses/re-serializes — so PR
 * diffs stay byte-clean and expression props / imports are never rewritten.
 *
 * It wraps an existing <textarea> (the submit handlers read that element's
 * .value), keeps it synced on every change, and exposes setValue so a re-load
 * updates the editor rather than silently desyncing. Lazily imported by the edit
 * islands so its ~200 KB is only paid on the editor pages.
 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

export interface SourceEditor {
  getValue(): string;
  setValue(v: string): void;
  focus(): void;
  /** Re-measure — call after the editor becomes visible (e.g. a hidden pane). */
  refresh(): void;
  destroy(): void;
}

// Theme-aware via CSS custom properties, so it follows the site's light/dark mode.
const wikiHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--color-primary)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--color-text)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--color-secondary)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--color-accent)' },
  { tag: [tags.list, tags.quote], color: 'var(--color-text-muted)' },
  { tag: [tags.meta, tags.processingInstruction, tags.contentSeparator], color: 'var(--color-text-muted)' },
]);

const wikiTheme = EditorView.theme({
  '&': {
    fontSize: '0.85rem', color: 'var(--color-text)',
    backgroundColor: 'var(--color-surface-base)',
    border: '1px solid var(--color-border)',
    borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
  },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: '10px 12px', caretColor: 'var(--color-primary)' },
  '.cm-scroller': { overflow: 'auto', minHeight: '20rem', maxHeight: '34rem', lineHeight: '1.55' },
  '&.cm-focused': { outline: '2px solid var(--color-primary-light)', outlineOffset: '1px', borderColor: 'var(--color-primary)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-primary)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--color-primary) 22%, transparent)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 30%, transparent)', outline: 'none',
  },
});

// ── insert-only toolbar commands (never reformat the doc) ────────────────────
function wrapSelection(view: EditorView, mark: string): void {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `${mark}${sel}${mark}` },
    selection: { anchor: from + mark.length, head: to + mark.length },
  });
  view.focus();
}

function toggleLinePrefix(view: EditorView, prefix: string): void {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const has = view.state.sliceDoc(line.from, line.from + prefix.length) === prefix;
  view.dispatch(
    has
      ? { changes: { from: line.from, to: line.from + prefix.length, insert: '' } }
      : { changes: { from: line.from, insert: prefix } },
  );
  view.focus();
}

function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || 'text';
  view.dispatch({
    changes: { from, to, insert: `[${sel}](url)` },
    selection: { anchor: from + 1, head: from + 1 + sel.length },
  });
  view.focus();
}

const TOOLBAR: Array<{ label: string; title: string; run: (v: EditorView) => void }> = [
  { label: 'B', title: 'Bold', run: (v) => wrapSelection(v, '**') },
  { label: 'i', title: 'Italic', run: (v) => wrapSelection(v, '*') },
  { label: 'H2', title: 'Heading', run: (v) => toggleLinePrefix(v, '## ') },
  { label: '• List', title: 'Bullet list', run: (v) => toggleLinePrefix(v, '- ') },
  { label: '🔗 Link', title: 'Link', run: insertLink },
  { label: '`code`', title: 'Inline code', run: (v) => wrapSelection(v, '`') },
];

/**
 * Replace a textarea with a CodeMirror editor, keeping the textarea in the DOM
 * (hidden) and its .value synced so existing submit handlers keep working.
 */
export function mountSourceEditor(textarea: HTMLTextAreaElement): SourceEditor {
  const wrap = document.createElement('div');
  wrap.className = 'wiki-cm';

  const bar = document.createElement('div');
  bar.className = 'wiki-cm__toolbar';

  const view = new EditorView({
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        history(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(wikiHighlight),
        wikiTheme,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) textarea.value = u.state.doc.toString();
        }),
      ],
    }),
  });

  for (const btn of TOOLBAR) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wiki-cm__btn';
    b.textContent = btn.label;
    b.title = btn.title;
    b.addEventListener('click', () => btn.run(view));
    bar.appendChild(b);
  }

  wrap.appendChild(bar);
  wrap.appendChild(view.dom);
  textarea.style.display = 'none';
  textarea.insertAdjacentElement('afterend', wrap);

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (v: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
      textarea.value = v;
    },
    focus: () => view.focus(),
    refresh: () => view.requestMeasure(),
    destroy: () => {
      view.destroy();
      wrap.remove();
      textarea.style.display = '';
    },
  };
}
