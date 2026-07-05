/** Display labels/icons for report types and statuses. Dependency-free (no
 *  firebase), so it's safe to import in Astro frontmatter and any island. */
import type { AnnotationType, AnnotationStatus } from './types';

export const TYPE_META: Record<AnnotationType, { label: string; icon: string }> = {
  error: { label: 'Error / incorrect', icon: '⚠️' },
  unclear: { label: 'Unclear', icon: '❓' },
  improvement: { label: 'Suggest improvement', icon: '✎' },
  review: { label: 'Request review', icon: '👁' },
};

/** Order the type picker + filters present them in. */
export const REPORT_TYPE_ORDER: AnnotationType[] = ['error', 'unclear', 'improvement', 'review'];

export const STATUS_META: Record<AnnotationStatus, { label: string; color: string }> = {
  open: { label: 'Open', color: 'var(--color-accent)' },
  'in-review': { label: 'In review', color: 'var(--color-primary)' },
  resolved: { label: 'Resolved', color: 'var(--color-secondary)' },
  wontfix: { label: "Won't fix", color: 'var(--color-text-muted)' },
};

export const STATUS_ORDER: AnnotationStatus[] = ['open', 'in-review', 'resolved', 'wontfix'];
