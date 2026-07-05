/**
 * Approximate, prose-only preview of an MDX lesson body for the editor.
 *
 * HONEST by design: it renders the Markdown prose and shows a labeled placeholder
 * wherever a component goes — it does NOT try to render the ~19 Astro components
 * (they only run at build time). Prose-slot wrappers (Callout/Steps/Reveal) keep
 * their inner content since that IS authored prose; data-backed and interactive
 * widgets become a card. The live site (or a PR build) is the real render.
 *
 * Operates on a COPY of the source; never mutates the editor buffer.
 */
import { marked } from 'marked';

// Wrappers whose inner content is authored prose — drop the tag, keep the body.
const PROSE_SLOT = /(<\/?(?:Callout|Steps|Reveal)\b[^>]*>)/g;
// Inline citation → a small chip showing the id.
const CITE = /<Cite\b[^>]*?\/>/g;
// Any remaining capitalized component (self-closing or paired) → a placeholder.
const WIDGET = /<([A-Z][A-Za-z0-9]*)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g;
// Leading MDX import/export lines.
const IMPORTS = /^[ \t]*(?:import|export)\b.*$/gm;

/** Minimal sanitizer — this previews the author's own input (self-XSS only), but
 *  we still strip anything executable before innerHTML. */
function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');
}

/** Render an MDX body to approximate preview HTML (prose + placeholder cards). */
export function renderPreview(mdxBody: string): string {
  let s = mdxBody.replace(IMPORTS, '');
  s = s.replace(CITE, (m) => {
    const id = (m.match(/id=["']([^"']+)["']/) || [])[1];
    return id ? ` \`[cite: ${id}]\` ` : ' `[cite]` ';
  });
  s = s.replace(PROSE_SLOT, '');
  s = s.replace(WIDGET, (_m, name) => `\n\n@@WIDGET:${name}@@\n\n`);

  let html = marked.parse(s, { async: false }) as string;
  // Swap the markers (marked may have wrapped them in <p>) for placeholder cards.
  html = html.replace(
    /(?:<p>)?\s*@@WIDGET:([A-Za-z0-9]+)@@\s*(?:<\/p>)?/g,
    (_m, name) =>
      `<div class="wiki-preview__widget"><strong>▸ ${name}</strong><span>renders on the live site</span></div>`,
  );
  return sanitize(html);
}
