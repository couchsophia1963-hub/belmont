import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `@testing-library/react` only registers its automatic cleanup when a global
// `afterEach` exists. This project runs Vitest with `globals: false` so that a
// missing import is a type error rather than a runtime surprise, which means
// there is no global for it to hang cleanup on. Without this, one test's DOM
// survives into the next and a route assertion can pass against the previous
// page's markup.
//
// `localStorage` goes with it. `ThemeProvider` writes the reader's theme choice
// there on mount, and jsdom keeps one store for the whole file, so a test that
// set a theme would hand the next test a different initial render.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// jsdom does not implement `window.matchMedia`. `ThemeProvider` (src/lib/theme.tsx)
// calls it during its first render to pick a starting theme, so without this every
// test that mounts the real `App` dies on `window.matchMedia is not a function`
// before a single assertion runs.
//
// This is a gap in the test environment, not a defect in the app, so it is stubbed
// here rather than by mocking `ThemeProvider` away — the routing tests are meant to
// render the real component tree, and a mocked provider would quietly stop covering
// whatever it does. The stub answers `false` for any query, so the theme is always
// `light` and a test never depends on a reader's system preference.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// `src/lib/supabase.ts` reads these at module load. Every test that renders the
// real app replaces that module with `test/supabaseMock.ts`, so no client is
// ever built and no request is ever made. These are here so that a future test
// which forgets to mock it fails on a missing value loudly instead of reaching
// for the network.
process.env.VITE_SUPABASE_URL ??= 'https://test.invalid';
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-anon-key-not-a-real-credential';