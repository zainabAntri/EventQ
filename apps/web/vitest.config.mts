import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // jsdom rather than happy-dom: axe-core exercises a lot of DOM API surface,
    // and jsdom's coverage is the more complete of the two.
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    css: false,
    // src/lib/env.ts validates NEXT_PUBLIC_* at module load and throws when they
    // are absent — deliberately, so a misconfigured deploy fails fast. Tests
    // therefore have to supply them. These are placeholders, never real values.
    env: {
      NEXT_PUBLIC_API_URL: 'http://localhost:4000',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    },
  },
});
