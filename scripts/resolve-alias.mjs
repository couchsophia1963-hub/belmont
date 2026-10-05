#!/usr/bin/env node
/**
 * Resolver hook for the `@/` path alias, so a plain `node` script can import the
 * real source modules.
 *
 * Vite handles `@/x` through `vite.config.ts` and `tsc` through the `paths`
 * block in `tsconfig.app.json`. `node` handles neither, so `import ... from
 * '@/lib/storyUrl'` throws there. Rather than check a copy of the logic, which
 * would drift and prove nothing, this hook maps `@/` onto `src/` and lets the
 * check scripts import the same files the bundle imports.
 *
 * Registered from a check script with:
 *
 *   import { register } from 'node:module';
 *   register('./resolve-alias.mjs', import.meta.url);
 *
 * before the first dynamic import of an aliased module.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Vite resolves an extensionless specifier; the candidates below are its order. */
const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function firstFile(base) {
  for (const candidate of [base, ...CANDIDATE_SUFFIXES.map((s) => base + s)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context);

  const found = firstFile(join(SRC_DIR, specifier.slice(2)));
  if (!found) throw new Error(`Cannot resolve "${specifier}" under src/`);

  return nextResolve(pathToFileURL(found).href, context);
}