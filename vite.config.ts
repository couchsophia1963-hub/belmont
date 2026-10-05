import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Where the built app is served from, as a path prefix.
 *
 * The app is published to two hosts with two different roots:
 *
 * - the Bolt host serves it at the domain root, so the prefix is `/`
 * - a GitHub Pages project site serves it from `/<repo>/`, so the prefix is
 *   `/belmont/`
 *
 * Hard-coding either one breaks the other deploy, so the value comes from the
 * environment and defaults to `/`. The Pages workflow sets `BASE_PATH`
 * explicitly. The default is the Bolt host's value, which means a build with no
 * `BASE_PATH` set is the live build, unchanged.
 *
 * Deliberately not `VITE_`-prefixed: that prefix also inlines the value into the
 * client bundle, and nothing in the app needs it there. The app reads
 * `import.meta.env.BASE_URL` instead, which Vite derives from this same value.
 */
const base = process.env.BASE_PATH ?? '/';

// https://vitejs.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
