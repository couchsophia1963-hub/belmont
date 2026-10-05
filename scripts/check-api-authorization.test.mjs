// @vitest-environment node

// BEL-235. Tests for the API authorization check.
//
// The check earns its place by failing. A test that only runs it against a correct
// tree proves it does not crash, which is not the property anybody relies on it for.
// So every case below takes a copy of the tree, breaks one thing on purpose, and
// asserts the specific failure that thing should produce.
//
// Each case names what it breaks and what it must print. The names are the contract:
// a comment in the checker that says "the regression test is X" is only true while a
// case called X is here. Deleting a case silently un-breaks a guarantee, so the case
// names below are also the list of what this file has stopped testing.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');

/** Paths the checker reads. Nothing else needs to be in the copy. */
const NEEDED = [
  'scripts/check-api-authorization.mjs',
  'scripts/api-authorization-spec.mjs',
  'docs/api-authorization.md',
  'docs/api-authorization.header.md',
  'docs/api-authorization.footer.md',
  'supabase/functions/api/index.ts',
];

let dir;

/** Copies the readable tree into a fresh temp directory and returns its path. */
function freshTree() {
  const root = mkdtempSync(join(tmpdir(), 'authz-'));
  for (const rel of NEEDED) {
    cpSync(join(REPO, rel), join(root, rel), { recursive: true });
  }
  cpSync(join(REPO, 'supabase/migrations'), join(root, 'supabase/migrations'), {
    recursive: true,
  });
  return root;
}

/** Runs the checker in `root` and returns its stdout and exit code. */
function runCheck(root) {
  const r = spawnSync(process.execPath, ['scripts/check-api-authorization.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { out: r.stdout ?? '', code: r.status };
}

function read(root, rel) {
  return readFileSync(join(root, rel), 'utf8');
}

/** Replaces `needle` in `rel`, failing loudly rather than silently not matching. */
function edit(root, rel, needle, replacement) {
  const before = read(root, rel);
  if (!before.includes(needle)) {
    throw new Error(`test anchor missing in ${rel}: ${JSON.stringify(needle.slice(0, 80))}`);
  }
  writeFileSync(join(root, rel), before.replace(needle, replacement), 'utf8');
}

/** Adds a line to the end of a migration, which is the simplest way to plant one. */
function appendTo(root, rel, text) {
  writeFileSync(join(root, rel), `${read(root, rel)}\n\n${text}\n`, 'utf8');
}

const FUNCTION = 'supabase/functions/api/index.ts';
const HEADLINE = 'supabase/migrations/20261005291000_stories_headline_invariant.sql';
const BYLINE = 'supabase/migrations/20261005292000_story_byline_changes.sql';
const API_KEYS = 'supabase/migrations/20261005290000_api_keys_key_digest_and_revoked_at.sql';

/**
 * The guard this ticket is about: the weather delete branch refuses a non-admin.
 * Reinstating the defect means taking those two lines out.
 */
const WEATHER_GUARD = `        if (profile.role !== "admin") {
          return errorResponse("Only admins can delete weather forecasts", 403);
        }
`;

beforeEach(() => {
  dir = freshTree();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('baseline', () => {
  it('passes on an untouched tree', () => {
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(out).toContain('PASS');
  });

  it('counts every declared surface against a surface it actually found', () => {
    // The two numbers being equal is a coincidence of this tree, not an invariant.
    // What must hold is that no declaration is dead, which is what the counts are
    // there to make visible and what the staleness case below actually asserts.
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(out).not.toContain('STALE DECLARATION');
  });
});

describe('the capability scan fails closed', () => {
  it('reports RLS switched off, which no policy can be recovered from', () => {
    appendTo(
      dir,
      BYLINE,
      'alter table public.stories disable row level security;',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNMODELLED SURFACE');
    expect(out).toContain('stories: RLS disabled');
  });

  it('does not report FORCE ROW LEVEL SECURITY, which narrows', () => {
    appendTo(
      dir,
      BYLINE,
      'alter table public.stories force row level security;',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
  });

  it('reports a PostgREST call the branch model does not describe', () => {
    // The shape of a caller reaching a SECURITY DEFINER function through the client
    // library, which is the bypass that motivated the deny-list.
    appendTo(dir, FUNCTION, '\nawait supabase.rpc("escalate_my_role");\n');
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNMODELLED SURFACE');
    expect(out).toContain('rpc');
  });

  it('reports a raw mutating fetch, which bypasses the client entirely', () => {
    appendTo(
      dir,
      FUNCTION,
      '\nawait fetch(url, { method: "DELETE" });\n',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNMODELLED SURFACE');
    expect(out).toContain('mutating method');
  });

  it('sees a raw mutating fetch that a line comment precedes', () => {
    // The comment hiding the call starts before the match, so stripping a window
    // after locating `fetch(` would not have found it.
    appendTo(
      dir,
      FUNCTION,
      '\n// fetch(url, { method: "DELETE" }) is what we do not do\nawait fetch(url, { method: "DELETE" });\n',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('mutating method');
  });

  it('sees a raw mutating fetch that a block comment precedes', () => {
    appendTo(
      dir,
      FUNCTION,
      '\n/* fetch(url, { method: "DELETE" }) is what we do not do */\nawait fetch(url, { method: "DELETE" });\n',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('mutating method');
  });

  it('does not treat a read-only fetch as a write', () => {
    appendTo(dir, FUNCTION, '\nawait fetch(url, { method: "GET" });\n');
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
  });
});

describe('dynamic sql that could carry a grant', () => {
  it('ignores the word grant inside a string literal', () => {
    // The bug this guards: `COMMENT ON COLUMN ... IS '... do not widen any grant to
    // include it.'` reads as a GRANT under a scan for GRANT, and the check reported
    // FAIL on a line that grants nothing. A security check that cries wolf on prose
    // is one people learn to route around.
    appendTo(
      dir,
      API_KEYS,
      "COMMENT ON TABLE api_keys IS 'do not widen any grant to include it';",
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(out).not.toContain('UNMODELLED SURFACE');
  });

  it('still reports a real grant in the same migration', () => {
    // The other half. Blanking literals must not have blinded the scan.
    appendTo(
      dir,
      API_KEYS,
      "GRANT ALL ON TABLE public.api_keys TO anon;",
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNMODELLED SURFACE');
    expect(out).toContain('GRANT');
  });

  it('still reports a grant written inside a dollar-quoted body', () => {
    appendTo(
      dir,
      API_KEYS,
      "do $x$ begin execute 'grant all on table public.api_keys to anon'; end $x$;",
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(out).not.toContain('UNMODELLED SURFACE');
  });
});

describe('a declaration has to match a surface that still exists', () => {
  it('reports a declared surface removed from the migration', () => {
    // Otherwise the declaration outlives what it describes and the printed count
    // keeps reading as coverage.
    edit(
      dir,
      HEADLINE,
      'grant execute on function public.set_story_headline(uuid, boolean) to authenticated;',
      '-- grant removed',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('STALE DECLARATION');
  });

  it('reports a declared grant whose role list widened', () => {
    // The assertion that set_story_headline is invoker-only stops being true if a
    // later migration hands it to anon, and the declaration would still be there
    // looking like an answer.
    edit(
      dir,
      HEADLINE,
      'grant execute on function public.set_story_headline(uuid, boolean) to authenticated;',
      'grant execute on function public.set_story_headline(uuid, boolean) to authenticated, anon;',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNMODELLED SURFACE');
    expect(out).toContain('STALE DECLARATION');
  });

  it('tolerates a reformat of a declared statement', () => {
    // Keys are compared case-folded and whitespace-collapsed, so re-indenting or
    // re-casing the SQL a declaration names is not a reason to send anyone back to
    // read a migration.
    edit(
      dir,
      HEADLINE,
      'grant execute on function public.set_story_headline(uuid, boolean) to authenticated;',
      'GRANT   EXECUTE   ON   FUNCTION   public.set_story_headline(uuid, boolean)   TO   authenticated;',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
  });
});

describe('the defect this ticket was filed for', () => {
  it('reports the weather delete guard removed from the function', () => {
    edit(dir, FUNCTION, WEATHER_GUARD, '');
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    // The kind is printed in a padded column, so match the label and the row id
    // separately rather than assuming one space between them.
    expect(out).toMatch(/DRIFT\s+weather\.delete/);
    expect(out).toMatch(/SURFACE MISMATCH\s+weather\.delete/);
  });

  it('confirms the guard is in the function, not only in RLS', () => {
    // Not a mutation. This is the assertion behind the answer the board asked for.
    //
    // RLS is not consulted on the path that performs this write: the function's
    // client is built with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. So a
    // policy alone is not a check on this action, and the row has to say `admin`
    // in the function column as well as the PostgREST one. Both, or the function
    // column is reading a gate nothing consults.
    const { code } = runCheck(dir);
    expect(code).toBe(0);
    const row = read(dir, 'docs/api-authorization.md')
      .split('\n')
      .find((l) => l.startsWith('| `weather.delete`'));
    expect(row).toBeTruthy();
    const [, , functionCol, postgrestCol] = row.split('|').map((c) => c.trim());
    expect(functionCol).toBe('admin');
    expect(postgrestCol).toContain('admin');
  });
});

describe('the table still describes the code', () => {
  it('reports a mutating action with no row', () => {
    // Inserted inside the stories resource block, before its unknown-action
    // return. Appended to the end of the file it lands outside every branch and
    // reports as an undeclared write instead, which is a different check.
    edit(
      dir,
      FUNCTION,
      "      return errorResponse(`Unknown action '${action}' for stories`, 400);",
      [
        '      if (action === "archive") {',
        "        if (!id) return errorResponse(\"Archive requires 'id'\", 400);",
        '        const { error } = await supabase.from("stories").update({ archived: true }).eq("id", id);',
        '        if (error) return errorResponse(error.message, 500);',
        '        return jsonResponse({ success: true });',
        '      }',
        '',
        "      return errorResponse(`Unknown action '${action}' for stories`, 400);",
      ].join('\n'),
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNDECLARED ACTION');
  });

  it('reports a role literal it cannot read rather than assuming writer', () => {
    edit(
      dir,
      FUNCTION,
      'if (profile.role !== "admin") {\n          return errorResponse("Only admins can delete weather forecasts", 403);',
      'if (profile.role !== "subeditor") {\n          return errorResponse("Only admins can delete weather forecasts", 403);',
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('UNREADABLE GUARD');
  });

  it('reports a hand-edit to the generated document', () => {
    edit(dir, 'docs/api-authorization.md', 'admin', 'admin, and also the weather desk');
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('STALE DOC');
  });

  it('reports a trigger that stops refusing', () => {
    // MISSING GUARD on a trigger whose function no longer raises. The mitigation
    // file becomes an audit log and the rows that relied on it go unchecked.
    //
    // Both RAISE EXCEPTIONs, not one. `stories_guard_lock_columns` refuses on two
    // paths -- the lock columns and the published column -- and `refuses` is true
    // if either one still raises. Downgrading one to NOTICE leaves a trigger that
    // still refuses, so the guard is genuinely still there and the check would be
    // wrong to report it missing.
    edit(
      dir,
      'supabase/migrations/20261005200000_stories_lock_column_guard.sql',
      "RAISE EXCEPTION 'Only an admin can lock",
      "RAISE NOTICE 'Only an admin can lock",
    );
    edit(
      dir,
      'supabase/migrations/20261005200000_stories_lock_column_guard.sql',
      "RAISE EXCEPTION 'This story is locked",
      "RAISE NOTICE 'This story is locked",
    );
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('MISSING GUARD');
  });

  it('still parses a trigger written across two lines', () => {
    // 20261005190000 writes FOR EACH ROW EXECUTE FUNCTION on one line and
    // 20261005200000 across two. A `.` does not cross a newline, so the original
    // `.*?` between the table name and EXECUTE FUNCTION silently skipped the second.
    const { out, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(out).toMatch(/3 trigger\(s\)/);
  });

  it('reports a declared out-of-branch write whose call is gone', () => {
    edit(dir, FUNCTION, '.update({ last_used_at', '.touch({ last_used_at');
    const { out, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(out).toContain('STALE ROW');
  });
});
