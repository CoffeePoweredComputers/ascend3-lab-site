// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import pagefind from 'astro-pagefind';

export default defineConfig({
  integrations: [mdx(), pagefind()],
  // Old admin URLs — wiki triage + publishing live at /wiki/admin; site-wide
  // admin (members, interest, news) stays at /admin. Keep old bookmarks working.
  redirects: {
    '/wiki/review': '/wiki/admin',
    '/wiki/publish': '/wiki/admin',
  },
  image: {
    domains: [
      'scholar.googleusercontent.com',
      'sethpoulsen.github.io',
      'ws.engr.illinois.edu',
    ],
  },
  vite: {
    plugins: [
      tailwindcss(),
      // Vite's public/ middleware serves files by exact path only — it never
      // resolves <dir>/ to <dir>/index.html the way nginx does in production.
      // Rewrite published slide-deck URLs so /slides/<slug>/ works in dev too.
      {
        name: 'slides-dir-index',
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url?.startsWith('/slides/') && req.url.endsWith('/')) req.url += 'index.html';
            next();
          });
        },
      },
    ],
    // Pre-bundle the lazily-imported Firebase modules at startup so Vite never
    // discovers them mid-session and re-optimizes (which invalidates already-served
    // chunks → "error loading dynamically imported module firebase_auth.js").
    optimizeDeps: {
      include: [
        'firebase/app', 'firebase/auth', 'firebase/firestore', 'js-yaml',
        '@codemirror/state', '@codemirror/view', '@codemirror/commands',
        '@codemirror/language', '@codemirror/lang-markdown', '@lezer/highlight',
        'marked', '@retorquere/bibtex-parser',
      ],
    },
  }
});
