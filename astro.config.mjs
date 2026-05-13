// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
