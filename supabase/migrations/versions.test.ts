// @vitest-environment node

/**
 * A migration reusing a recorded version key is SKIPPED, not refused.
 *
 * Supabase keys `supabase_migrations` on the numeric filename prefix of
 * `supabase/migrations/<version>_<name>.sql`. Two files sharing a version key in
 * one push means one is applied and the other is dropped -- with no error at
 * `db push` and no error anywhere afterwards. The migration's changes are absent
 * from the database while the repository, the PR description and every review of
 * it say they are present.
 *
 * That silence is the whole problem. There is no failure message to read, so the
 * next person to meet a missing column concludes the migration was never merged,
 * and re-merges it. This test is the only thing that notices.
 *
 * It compares against `origin/main` as well as against the branch itself. A
 * branch-only check would not have caught the real cases in this repo, because
 * every one of them collided with something that was not on the branch: a key
 * `main` had already recorded, or a key a sibling PR had claimed. Both of those
 * only become a duplicate at merge time.
 *
 * WHAT THIS DOES NOT COVER, stated plainly rather than left for the next person to
 * assume: a collision with a *sibling open PR* is not detected here, because that
 * needs the list of open pull requests, which needs the GitHub API. The keys used
 * locally could be probed against every unmerged remote branch instead, and that
 * was tried: 42 branches are unmerged and carry migrations, and a branch that
 * deleted or renamed a migration after its work was merged keeps colliding with
 * `main` forever. That is the `.sql.sql` case in this very repo, so the probe
 * produces permanent false positives and would have to be ignored -- which is how
 * a check stops being a check. A sibling-PR collision is therefore prevented by
 * convention instead: keys are handed out from one reserved block per merge
 * window, recorded in `supabase/migrations/README.md`, rather than picked as
 * "now" by each author independently.
 *
 * The keys that ARE covered here are the ones where the loss is permanent: a key
 * `main` has already recorded can never be applied again without deleting the
 * row, so the migration is unrecoverable and silent.
 *
 * A file edited in place -- same path, changed content -- is a different
 * question and is deliberately out of scope here. Editing an already-applied
 * migration means the edit never reaches a database that already ran it. That is
 * BEL-180.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = 'supabase/migrations';

/** Supabase accepts `<version>_<name>.sql`. The version must be all digits. */
const MIGRATION_FILENAME = /^(\d+)_([^/]+)\.sql$/;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Migration filenames on a ref, or `[]` when the ref has no such directory. */
function migrationsOnRef(ref: string): string[] {
  let out: string;
  try {
    out = git(['ls-tree', '-r', '--name-only', ref, '--', MIGRATIONS_DIR]);
  } catch {
    // A ref that does not resolve locally is not a migration problem; the
    // ref-resolution test below is what reports it, with an accurate message.
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.sql'))
    .map((line) => line.slice(MIGRATIONS_DIR.length + 1));
}

/**
 * The migrations in the working tree -- that is, on the branch under test.
 *
 * Read from the filesystem rather than from `git ls-tree HEAD` so that the check
 * also covers an unstaged or uncommitted file. A duplicate created but not yet
 * committed is still a duplicate, and CI only ever sees the committed tree.
 */
function migrationsInWorkingTree(): string[] {
  let out: string;
  try {
    out = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', MIGRATIONS_DIR]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.sql'))
    .map((line) => line.slice(MIGRATIONS_DIR.length + 1));
}

const versionKey = (filename: string): string => MIGRATION_FILENAME.exec(filename)?.[1] ?? '';

interface Collision {
  key: string;
  files: string[];
}

function findCollisions(...groups: string[][]): Collision[] {
  // key -> distinct paths claiming it. A key claimed by one path only is fine,
  // however many branches that path appears on.
  const byKey = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const file of group) {
      const key = versionKey(file);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key)!.add(file);
    }
  }
  return [...byKey.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([key, files]) => ({ key, files: [...files].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function describeCollision(c: Collision): string {
  return `version key ${c.key} is claimed by ${c.files.length} different files:\n` +
    c.files.map((f) => `    ${f}`).join('\n') +
    '\n\nSupabase will apply one of these and silently skip the rest. Give this\n' +
    'migration a version key that no other file uses, then check `main` and every\n' +
    'open PR before picking one -- the collisions that actually happen are with\n' +
    'sibling PRs, not with `main`.';
}

/**
 * `origin/main` is the merge target. CI checks out a detached merge commit, so
 * the local branch `main` may not exist, and a shallow clone has neither.
 */
function resolveBaseRef(): string | null {
  for (const ref of ['origin/main', 'refs/remotes/origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
      return ref;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

describe('supabase migration version keys', () => {
  it('names every migration <digits>_<name>.sql', () => {
    const bad = migrationsInWorkingTree().filter((f) => !MIGRATION_FILENAME.test(f));
    expect(
      bad,
      `Supabase reads the version key from the numeric prefix of the filename, so a name that does not\n` +
      `start with digits gets no key at all. Rename these to <version>_<name>.sql:\n` +
      (bad.length ? bad.map((f) => `    ${f}`).join('\n') : '    (none)'),
    ).toEqual([]);
  });

  it('does not reuse a version key within this branch', () => {
    expect(
      findCollisions(migrationsInWorkingTree()),
      'Two migrations on this branch share a version key.',
    ).toEqual([]);
  });

  it('can see the merge target', () => {
    // Not a migration assertion. A check that quietly passes because it could
    // not read `origin/main` would report no collisions at all, which is the
    // exact failure this file exists to prevent.
    const ref = resolveBaseRef();
    expect(
      ref,
      'Could not resolve `origin/main`, so the collision check below would have nothing to compare\n' +
      'against and would pass no matter what it found.\n' +
      'Fix the checkout: `.github/workflows/ci.yml` must use `fetch-depth: 0`, otherwise the runner\n' +
      'has a shallow history with no remote-tracking refs.',
    ).not.toBeNull();
  });

  it('does not collide with a version key already recorded on the merge target', () => {
    const ref = resolveBaseRef();
    if (ref === null) return; // the previous test fails with the actionable message

    const collisions = findCollisions(migrationsOnRef(ref), migrationsInWorkingTree());
    expect(
      collisions,
      collisions.length
        ? `Merging this branch would put more than one file on a version key.\n\n` +
          collisions.map(describeCollision).join('\n\n')
        : '',
    ).toEqual([]);
  });
});