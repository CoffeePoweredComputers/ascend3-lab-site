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
    plugins: [tailwindcss()]
  }
});
