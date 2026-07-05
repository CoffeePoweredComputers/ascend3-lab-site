// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';

export default defineConfig({
  integrations: [mdx()],
  image: {
    domains: [
      'scholar.googleusercontent.com',
      'sethpoulsen.github.io',
      'ws.engr.illinois.edu',
    ],
  },
  vite: {
    plugins: [tailwindcss()],
    // Pre-bundle the lazily-imported Firebase modules at startup so Vite never
    // discovers them mid-session and re-optimizes (which invalidates already-served
    // chunks → "error loading dynamically imported module firebase_auth.js").
    optimizeDeps: {
      include: [
        'firebase/app', 'firebase/auth', 'firebase/firestore', 'js-yaml',
        '@codemirror/state', '@codemirror/view', '@codemirror/commands',
        '@codemirror/language', '@codemirror/lang-markdown', '@lezer/highlight',
        'marked',
      ],
    },
  }
});
