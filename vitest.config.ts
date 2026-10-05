import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// BEL-141. `npm test` runs this.
//
// The `@` alias is repeated from `vite.config.ts` rather than merged from it,
// because Vitest resolves this config on its own and does not read the Vite
// config unless it is passed to `mergeConfig` here. If a path moves, both files
// must change together — the typecheck already fails if `@/*` in
// `tsconfig.app.json` and the import sites disagree, and `npm run build` fails
// if the two configs disagree, so CI catches the drift.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});