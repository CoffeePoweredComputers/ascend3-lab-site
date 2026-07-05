/**
 * Highlight rendering via the CSS Custom Highlight API.
 *
 * We register Ranges with `CSS.highlights` and style them through
 * `::highlight(wiki-annotation)` in wiki.css. Crucially this mutates NO DOM — so
 * highlights can freely cross element boundaries and skip inline nodes without
 * the `Range.surroundContents()` throw, and they never interfere with the
 * interactive widgets' event listeners or Astro island hydration.
 *
 * The catch: a highlight is not a DOM element, so it has no click handler.
 * `hitTest(x, y)` recovers the annotation under a pointer from the stored Ranges.
 *
 * The `Highlight`/`HighlightRegistry` DOM types aren't in every TS lib version,
 * so the API is accessed through small `any` shims behind a feature check.
 */

const HL_BASE = 'wiki-annotation';
const HL_ACTIVE = 'wiki-annotation-active';

/** True when the browser supports the CSS Custom Highlight API. */
export function highlightsSupported(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof (window as unknown as { Highlight?: unknown }).Highlight !== 'undefined'
  );
}

const ranges = new Map<string, Range>();
let activeId: string | null = null;

/** Whole-widget (block) annotations are marked with a class, not a text range. */
const blockMarks = new Map<string, HTMLElement>();

function registry(): Map<string, unknown> {
  return (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
}
function makeHighlight(rs: Range[]): unknown {
  const H = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  return new H(...rs);
}

function repaint(): void {
  if (!highlightsSupported()) return;
  const reg = registry();
  const base: Range[] = [];
  const active: Range[] = [];
  for (const [id, r] of ranges) (id === activeId ? active : base).push(r);
  if (base.length) reg.set(HL_BASE, makeHighlight(base));
  else reg.delete(HL_BASE);
  if (active.length) reg.set(HL_ACTIVE, makeHighlight(active));
  else reg.delete(HL_ACTIVE);
}

/** Add or replace the highlight for an annotation id. */
export function setHighlight(id: string, range: Range): void {
  ranges.set(id, range);
  repaint();
}

export function removeHighlight(id: string): void {
  ranges.delete(id);
  if (activeId === id) activeId = null;
  repaint();
}

export function clearHighlights(): void {
  ranges.clear();
  activeId = null;
  repaint();
  for (const el of blockMarks.values()) el.classList.remove('wiki-block-annotated');
  blockMarks.clear();
}

/** Mark a whole widget as annotated (outline). Adds a class only — no inner DOM. */
export function setBlockMarker(id: string, el: HTMLElement): void {
  blockMarks.set(id, el);
  el.classList.add('wiki-block-annotated');
}

export function removeBlockMarker(id: string): void {
  const el = blockMarks.get(id);
  if (el) el.classList.remove('wiki-block-annotated');
  blockMarks.delete(id);
}

/** Emphasize one annotation (e.g. the open thread); pass null to clear. */
export function setActiveHighlight(id: string | null): void {
  activeId = id;
  repaint();
}

export function highlightedIds(): string[] {
  return [...ranges.keys()];
}

/** The annotation id under a viewport point, preferring the smallest (topmost)
 *  overlapping highlight; null if none. */
export function hitTest(x: number, y: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const [id, range] of ranges) {
    for (const rect of Array.from(range.getClientRects())) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const area = rect.width * rect.height;
        if (area < bestArea) {
          bestArea = area;
          best = id;
        }
      }
    }
  }
  return best;
}
