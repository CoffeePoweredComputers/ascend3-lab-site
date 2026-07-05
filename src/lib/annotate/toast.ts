/**
 * Minimal toast notifications for transient action feedback — replaces the
 * jarring native alert() with something that matches the site's visual language.
 * Pure DOM, no Firebase, so it's a cheap static import from any island.
 *
 * A toast auto-dismisses (errors linger longer) and can be clicked to dismiss
 * early. Pass a link to make the whole toast actionable (e.g. "Opened #42 ↗").
 */
type ToastKind = 'success' | 'error' | 'info';

interface ToastOptions {
  href?: string;
  linkText?: string;
  timeout?: number;
}

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  container = document.createElement('div');
  container.className = 'wiki-toasts';
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}

export function toast(message: string, kind: ToastKind = 'info', opts: ToastOptions = {}): void {
  const el = document.createElement('div');
  el.className = `wiki-toast wiki-toast--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);

  if (opts.href) {
    const a = document.createElement('a');
    a.href = opts.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = opts.linkText || 'Open ↗';
    // Let the link click through without the toast's own dismiss swallowing it.
    a.addEventListener('click', (e) => e.stopPropagation());
    el.appendChild(a);
  }

  ensureContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 300);
  };

  const timer = setTimeout(dismiss, opts.timeout ?? (kind === 'error' ? 8000 : 4000));
  el.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });
}
