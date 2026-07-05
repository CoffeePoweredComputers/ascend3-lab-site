/**
 * Text anchoring for the annotation layer (Hypothesis-style, hand-rolled, no deps).
 *
 * A `Selector` describes a span of text relative to the `.wiki-annotatable` root:
 *   - `start`/`end`  — char offsets into the root's raw text (fast path)
 *   - `quote`        — the exact text (so we can re-find it if offsets drift)
 *   - `prefix`/`suffix` — surrounding context to disambiguate repeated quotes
 *
 * The text model is the raw concatenation of every text node under the root, in
 * document order, SKIPPING any subtree marked `[data-no-annotate]` (interactive
 * widgets whose scripts mutate their own DOM). `describe()` derives the quote
 * from this same model — not from Selection.toString() — so a describe→anchor
 * round-trip on unchanged content is always an exact position match.
 *
 * Rendering the resolved Range is the caller's job (see highlight.ts); this
 * module only maps between Ranges and Selectors.
 */
import type { TextSelector, BlockSelector } from './types';

/** Chars of context stored on each side of the quote. */
const CONTEXT = 32;

/** Interactive widgets whose own scripts mutate their DOM — never annotate inside
 *  them. Kept here (not in each component) so the skip-list lives in one place;
 *  components may also self-mark by adding `data-no-annotate` to their root. */
export const INTERACTIVE_SELECTOR =
  '.wiki-kappa, .wiki-tree, .wiki-sat, .wiki-dist, .wiki-measures, .wiki-flow, .wiki-transcript, .wiki-roles';

/** Stamp interactive widgets under `root` with `data-no-annotate`. Idempotent. */
export function markInteractive(root: ParentNode): void {
  root.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) =>
    el.setAttribute('data-no-annotate', ''),
  );
}

type CharPos = { node: Text; offset: number };
type Model = { text: string; chars: CharPos[]; nodeStart: Map<Text, number> };

function makeWalker(root: Node): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-no-annotate]')) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

/** Flatten the annotatable text of `root` into a string + per-char DOM positions. */
function buildModel(root: Element): Model {
  const walker = makeWalker(root);
  const chars: CharPos[] = [];
  const nodeStart = new Map<Text, number>();
  let text = '';
  let n = walker.nextNode() as Text | null;
  while (n) {
    nodeStart.set(n, text.length);
    const data = n.data;
    for (let i = 0; i < data.length; i++) chars.push({ node: n, offset: i });
    text += data;
    n = walker.nextNode() as Text | null;
  }
  return { text, chars, nodeStart };
}

// ── Range → Selector ─────────────────────────────────────────────────────────

/** First accepted text node that is `ref` itself or comes at/after it. */
function firstAtOrAfter(ordered: Text[], ref: Node): Text | null {
  for (const t of ordered) {
    if (t === ref) return t;
    const pos = ref.compareDocumentPosition(t);
    if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY || pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      return t;
    }
  }
  return null;
}

/** Last accepted text node contained by element `el`. */
function lastContainedBy(ordered: Text[], el: Element): Text | null {
  let last: Text | null = null;
  for (const t of ordered) {
    if (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_CONTAINED_BY) last = t;
  }
  return last;
}

/** Map a DOM boundary (container, offset) to a char index in the model. */
function boundaryIndex(model: Model, ordered: Text[], container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const t = container as Text;
    if (!model.nodeStart.has(t)) return null; // inside a skipped subtree
    return model.nodeStart.get(t)! + Math.min(offset, t.data.length);
  }
  // Element container: boundary sits before childNodes[offset].
  const kids = container.childNodes;
  if (offset < kids.length) {
    const node = firstAtOrAfter(ordered, kids[offset]);
    return node ? model.nodeStart.get(node)! : model.text.length;
  }
  const last = lastContainedBy(ordered, container as Element);
  return last ? model.nodeStart.get(last)! + last.data.length : model.text.length;
}

/** Build a TextSelector from a live Range within `root` (null if empty/invalid). */
export function describe(root: Element, range: Range): TextSelector | null {
  const model = buildModel(root);
  const ordered = [...model.nodeStart.keys()];
  const start = boundaryIndex(model, ordered, range.startContainer, range.startOffset);
  const end = boundaryIndex(model, ordered, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;

  const quote = model.text.slice(start, end);
  if (!quote.trim()) return null;

  return {
    kind: 'text',
    quote,
    prefix: model.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: model.text.slice(end, end + CONTEXT),
    start,
    end,
  };
}

// ── Selector → Range ─────────────────────────────────────────────────────────

/** indexOf occurrence of `needle` nearest to `target` (or -1). */
function nearestIndexOf(text: string, needle: string, target: number): number {
  if (!needle) return -1;
  let best = -1;
  let bestDist = Infinity;
  let from = 0;
  let i = text.indexOf(needle, from);
  while (i !== -1) {
    const d = Math.abs(i - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
    from = i + 1;
    i = text.indexOf(needle, from);
  }
  return best;
}

/** Locate the quote using prefix/suffix context; returns quote-start index or -1. */
function locateWithContext(text: string, sel: TextSelector): number {
  if (sel.prefix) {
    const pq = nearestIndexOf(text, sel.prefix + sel.quote, sel.start - sel.prefix.length);
    if (pq >= 0) return pq + sel.prefix.length;
  }
  if (sel.suffix) {
    const qs = nearestIndexOf(text, sel.quote + sel.suffix, sel.start);
    if (qs >= 0) return qs;
  }
  return nearestIndexOf(text, sel.quote, sel.start);
}

/** Collapse whitespace runs; keep a map from normalized index → raw index. */
function normalizeWithMap(raw: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (/\s/.test(c)) {
      if (prevSpace) continue;
      norm += ' ';
      map.push(i);
      prevSpace = true;
    } else {
      norm += c;
      map.push(i);
      prevSpace = false;
    }
  }
  map.push(raw.length); // sentinel for an end boundary
  return { norm, map };
}

/** Resolve a Selector to raw start/end indices, most-precise tier first. */
function locate(text: string, sel: TextSelector): { start: number; end: number } | null {
  // Tier 1 — position is still exact.
  if (text.slice(sel.start, sel.end) === sel.quote) return { start: sel.start, end: sel.end };
  // Tier 2 — exact quote, disambiguated by context, nearest to old position.
  const i = locateWithContext(text, sel);
  if (i >= 0) return { start: i, end: i + sel.quote.length };
  // Tier 3 — whitespace-tolerant (handles reflowed prose).
  const { norm, map } = normalizeWithMap(text);
  const nq = sel.quote.replace(/\s+/g, ' ').trim();
  if (nq) {
    const ni = norm.indexOf(nq);
    if (ni >= 0) return { start: map[ni], end: map[Math.min(ni + nq.length, map.length - 1)] };
  }
  return null; // orphaned
}

function rangeFromIndices(model: Model, start: number, end: number): Range | null {
  const { chars } = model;
  const endClamped = Math.min(end, chars.length);
  if (start >= endClamped) return null;
  const a = chars[start];
  const b = chars[endClamped - 1];
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset + 1);
  return range;
}

/** Resolve a Selector to a live Range within `root`. null = orphaned (text gone). */
export function anchor(root: Element, sel: TextSelector): Range | null {
  const model = buildModel(root);
  const found = locate(model.text, sel);
  return found ? rangeFromIndices(model, found.start, found.end) : null;
}

/** The raw annotatable text of `root` (skipped subtrees excluded). Dev/debug aid. */
export function annotatableText(root: Element): string {
  return buildModel(root).text;
}

// ── Block anchoring (whole interactive widgets) ──────────────────────────────
// Widgets are `data-no-annotate` (text can't anchor inside), but can be commented
// on as a unit. We stamp each with a stable id and point BlockSelectors at it.

const BLOCK_LABELS: Record<string, string> = {
  'wiki-tree--nav': 'IRB navigator', // must precede 'wiki-tree' (IRBNavigator has both)
  'wiki-kappa': 'Kappa calculator',
  'wiki-tree': 'Decision tree',
  'wiki-sat': 'Saturation curve',
  'wiki-dist': 'Distribution plot',
  'wiki-measures': 'Measure explorer',
  'wiki-flow': 'Process flow',
  'wiki-transcript': 'Coded transcript',
  'wiki-roles': 'Role walkthrough',
};

function blockKey(el: Element): string {
  for (const key of Object.keys(BLOCK_LABELS)) if (el.classList.contains(key)) return key;
  return 'block';
}

export interface Block {
  el: HTMLElement;
  blockId: string;
  label: string;
}

/** Stamp each interactive widget under `root` with a stable `data-block-id`
 *  (type + ordinal, e.g. "wiki-kappa-0") and return them. Idempotent per load. */
export function assignBlockIds(root: ParentNode): Block[] {
  const counts: Record<string, number> = {};
  const blocks: Block[] = [];
  root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR).forEach((el) => {
    const key = blockKey(el);
    const n = (counts[key] = (counts[key] ?? 0) + 1);
    const blockId = `${key}-${n - 1}`;
    el.setAttribute('data-block-id', blockId);
    blocks.push({ el, blockId, label: BLOCK_LABELS[key] ?? 'Widget' });
  });
  return blocks;
}

/** The interactive widget an event target sits inside, or null. */
export function widgetAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(INTERACTIVE_SELECTOR) : null;
}

/** Describe a whole widget as a BlockSelector (call assignBlockIds first). */
export function describeBlock(el: HTMLElement): BlockSelector | null {
  const blockId = el.getAttribute('data-block-id');
  if (!blockId) return null;
  return { kind: 'block', blockId, label: BLOCK_LABELS[blockKey(el)] ?? 'Widget' };
}

/** Resolve a BlockSelector back to its widget element (null if gone). */
export function anchorBlock(root: ParentNode, sel: BlockSelector): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(sel.blockId)}"]`);
}
