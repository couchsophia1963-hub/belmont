/*
# api_keys: drop the plaintext column, and require a digest

## 1. Purpose

`api_keys.key_hash` holds the raw desk credential. After this file the table holds a digest and
nothing else, so a read of `api_keys` yields no working key for anybody.

This is the step that actually removes the plaintext. The three files before it made the plaintext
*redundant* -- a digest beside it, a writer that fills it, a function that reads the digest instead
-- and redundancy is not removal. As long as the column exists it holds the credential and every
writer that names it can keep writing it.

## 2. What this file does NOT do

- It does not change the edge function. `supabase/functions/api/index.ts` looking the key up by
  `key_hash` is the previous file's job. **If that change has not landed, this file breaks every API
  call in the system**, because the function's lookup column will no longer exist. See section 3.
- It does not rotate anything. Every key in the table at this moment keeps working, and none of them
  needs replacing: the digest that was derived from each row's own plaintext during the previous
  file is exactly what the function now looks up.
- It does not touch `revoked_at`, any policy, or any grant it can avoid.
- It does not change `key_prefix`. That column is `bcn_` plus the first eight characters, shown in
  the panel so a human can tell two keys apart in a list. It is not part of the secret and it never
  was.

## 3. Order, and the one thing that makes this file unsafe to apply early

Three files, in this order, and the reason is not tidiness:

1. **A digest beside the credential** -- adds `key_digest`, converts every row in place, installs
   `api_keys_fill_key_digest`, adds `revoked_at`. Additive; safe to apply with the old code live.
2. **The edge function authenticates by `key_digest`, and the panel stops deleting keys.** This is
   where the last reader of `key_hash` goes away.
3. **This file.**

Between (1) and (3) the database holds both representations on purpose, because two writers still
have to keep working across the window: the deployed panel, which sends `key_hash` and has never
heard of `key_digest`, and the deployed function, which reads `key_hash`.

The temptation is to collapse (2) and (3) into one file. Do not. If the column goes while the
function still reads it, the failure is not a slow degradation -- the lookup `.eq("key_hash", ...)`
against a table with no such column raises on every single call. Every publish, every API call, from
every reporter, stops at once, and the error says nothing about why. The plaintext is gone from the
schema but the credential that was in it is now unrecoverable, so the fix is not "put the column
back" -- it is a rotation of every desk key.

So the check is not stylistic: **do not apply this file until the function reads `key_digest`.**

## 4. This file refuses rather than deletes a live credential

Before anything is dropped, this file counts the rows that have no digest. If there are any, it
raises and nothing has run.

That count is the whole point of the file. A row with `key_digest IS NULL` is a row whose plaintext
exists and whose digest does not. The obvious repair is to derive the digest from the plaintext --
and that repair is available *right now*, while `key_hash` is still on the table. The moment this
file runs, it is not: the plaintext this migration was going to read is the thing being deleted. A
NULL digest after this file is permanent, and it presents as a 401 to whoever holds that credential,
with nothing in the table to explain it.

So the refusal is the migration doing its job. A migration that drops a column holding live
credentials and merely prints a `SELECT count(*)` in a comment, or in an operator's terminal, has
moved the safety decision out of the transaction and into somebody's memory, which is where it will
be lost. It is in the file, it runs every time the file runs, and it aborts.

There is a second, structural guard underneath: `SET NOT NULL` in step 4 is itself a refusal. Even
if this census block were removed, PostgreSQL would refuse to set the constraint while a NULL row
exists. The census is here so the failure arrives *before* the trigger and the index are dropped,
with a message that names the cause.

A malformed digest -- present, but not 64 lowercase hex characters -- is counted and reported rather
than refused on. It is a different failure: the row's plaintext is still readable at this moment, so
the value can be re-derived, and a value that was never
`encode(digest(key_hash, 'sha256'), 'hex')` says something about a writer nobody has identified yet.
That is worth reading, not worth blocking the removal of the plaintext over. Section 5 prints it.

## 5. The trigger has to go first, and the reason is not cosmetic

`api_keys_fill_key_digest` reads `NEW.key_hash`. It exists to keep the two representations in
agreement across the window described in section 3. Once the column is gone the function is wrong:
a plpgsql body is parsed at `CREATE` time but its statements are prepared at call time, and the
column reference is *not* recorded as a dependency. `ALTER TABLE ... DROP COLUMN key_hash` therefore
succeeds while the trigger is still attached -- and the trigger then raises on the next `INSERT` or
`UPDATE` to `api_keys`, from inside the writer's transaction, on a column it can no longer see.

That is the failure mode the whole window was designed to avoid: a just-issued key refused, with
nothing visible from any column. Drop the trigger first, then the function, then the column. In that
order the failure cannot happen, because there is nothing left that reads the column.

Dropping the function after the trigger, and not before, is required rather than stylistic: a trigger
is a dependent object of its function, and `DROP FUNCTION` on a function a trigger still uses is
refused by PostgreSQL.

`idx_api_keys_hash` is dropped explicitly. It is not necessary -- PostgreSQL drops any index
involving a dropped column on its own, and the base schema's inline
`key_hash text NOT NULL UNIQUE` (`:223`) takes its unique index
`api_keys_key_hash_key` down the same way. It is named here so that a replay finds nothing to do
and so that the operator reading the output can see the two indexes go, rather than inferring it.

## 6. `NOT NULL` moves here, and not into the earlier file

`key_digest` was left nullable in the previous file for a reason that has now expired. Its `insert`
did not name the column, and `NOT NULL` would have failed on the **deployed** panel's next key
creation -- the migration-before-frontend rule running in the direction people forget to check.

That argument is now reversed, and it belongs on the column. After this file the trigger is gone, so
nothing in the database derives a digest from anything; a writer that omits `key_digest` produces a
row that no lookup can ever match, and it would sit there looking like a working key in the panel
list. A key that cannot authenticate and does not say so is worse than a key creation that fails
loudly. The constraint is the loud failure.

`SET NOT NULL` takes `ACCESS EXCLUSIVE` and scans the table. That is worth naming rather than
discovering: `api_keys` holds one row per issued key, so it is a handful of rows, and it takes a
brief exclusive lock on a table that only the panel and the edge function touch. Run it when nobody
is creating a key.

## 7. Grants: carried forward unchanged, and one thing that is now true

The precheck from the previous file is repeated here unchanged, and it is still a precheck and not
an assumption:

    select
      (select count(*) > 0
         from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'api_keys'
          and grantee = 'authenticated' and privilege_type = 'INSERT')
        as insert_is_table_level,
      (select coalesce(string_agg(column_name, ', ' order by column_name), '')
         from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'api_keys'
          and grantee = 'authenticated' and privilege_type = 'INSERT')
        as insert_column_scope,
      (select count(*) > 0
         from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'api_keys'
          and grantee = 'authenticated' and privilege_type = 'SELECT')
        as select_is_table_level,
      (select coalesce(string_agg(column_name, ', ' order by column_name), '')
         from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'api_keys'
          and grantee = 'authenticated' and privilege_type = 'SELECT')
        as select_column_scope;

Two traps when reading the result, both carried forward:

- A table-level grant is reported in `column_privileges` as well, expanded to one row per column. A
  populated `*_column_scope` is therefore **not** by itself evidence of a narrow grant. Compare
  `table_privileges` against `column_privileges` for the same grantee and privilege, exactly as
  `20261005190000_profiles_role_not_self_assignable.sql` section 4 does.
- The table owner appears in these views with its implicit privileges whether or not anything was
  ever granted, so scope the query to `grantee = 'authenticated'`.

**What is different at this point is that `key_hash` is gone, so any grant naming it has been
dropped with it.** PostgreSQL drops a column privilege with the column, and a table-level grant is
not affected -- so on a table-level grant nothing changes, and on a column-scoped grant the privilege
list simply gets shorter by one. There is no grant in this file, for the same reason there was none
in the previous one: adding one here would be a change made while a migration that destroys data is
running, and a narrowed grant that half-applies leaves the panel writing blind, which is worse than
not shipping. If the precheck comes back column-scoped, that is a separate migration, and it is a
decision to make before this file rather than while it runs.

Section 6 reads the grants back **after** the column is gone, so the answer can be compared against
the precheck directly.

Across every migration in this repository the only `GRANT` or `REVOKE` is on `public.comments_public`
(`20261005160000_comments_public_view.sql:102-103`), and
`20261005140000_weather_forecasts_deferred_fields.sql:180` leaves its own grant block commented out
on purpose. There has never been a column-scoped grant on `api_keys`.

**No agent on this beat can run this precheck or apply this file.** The installed Supabase connection
points at the Shipwright project, not Belmont News (BEL-48). Applying it is a human action in the
Supabase dashboard, and it has not been applied.

## 8. The panel's write path moves with this file

The deployed panel writes `key_hash` and nothing else. After this file that column does not exist, so
its `insert` fails with *column does not exist* on the next key creation. That is loud, immediate,
and confined to the admin panel -- and it is the correct direction to fail, because the failure is at
the boundary the change is about and it cannot reach a reader.

The panel shipped with this file writes `key_digest` instead, computed with `crypto.subtle.digest`
over the UTF-8 bytes of the key: lowercase hex, no prefix, byte-identical to
`encode(digest(key_hash, 'sha256'), 'hex')`. The raw key never leaves the page; it is shown once at
creation and never again, which is the discipline the panel already implied.

**So the order at deploy time is: deploy the panel that writes `key_digest`, then apply this file.**
Applying it first costs key creation and key rotation in the panel until the panel ships. It does
not cost any reader anything, and it does not break any existing key. Do it in the order above and
there is no window at all.

## 9. Rerunnable

`DROP TRIGGER IF EXISTS`, `DROP FUNCTION IF EXISTS`, `DROP INDEX IF EXISTS`,
`DROP COLUMN IF EXISTS` and a census guarded on the shapes rather than on a version are each safe to
run again against a database where this file has already been applied. `SET NOT NULL` on a column
that is already `NOT NULL` re-validates and succeeds.

`DROP COLUMN IF EXISTS` rather than `DROP COLUMN` is the one that matters. A version-keyed migration
ledger **skips** a file at a version it has already recorded rather than rejecting it, so a replayed
file is silent (BEL-180, PR #27), and a plain `DROP COLUMN key_hash` would abort on the second run
with *column "key_hash" does not exist* -- an error that reads like a failed migration and invites
somebody to go looking for the wrong thing.

## 10. Verification, and its limits

**No agent on this beat can apply this.** This is written and reviewed, not applied.

What was done to it:

- **The whole file parses.** All 10 top-level statements are accepted by PostgreSQL 18's own parser
  (`libpg-query`, `parseSync`), and all 3 PL/pgSQL units are accepted by `parsePlPgSQLSync` with no
  errors. Statement order was checked as well: the two `DO` blocks come first and the first `DROP`
  is the third statement, so the census cannot be reached after anything has been dropped.
- Dollar-quoting, single quotes and block comments were checked with a lexer that follows the
  server's rules. That is not a formality here -- the message in the refusal quotes
  `encode(digest(key_hash, 'sha256'), 'hex')`, so the file carries a doubled single quote inside a
  string, and a nesting mistake in that region is invisible to a reader and to a diff.
- Every `RAISE` was checked to have as many format placeholders as arguments, with each argument
  declared. This is a runtime check in PL/pgSQL, not a parse-time one: a `RAISE NOTICE` with a
  placeholder and no argument compiles cleanly and raises at the moment somebody runs the
  post-apply check, which is the worst moment to find it.
- The census is one query. The `NOTICE` prints the count and the `EXCEPTION` tests the same
  variable from that same query, so the number the operator reads is the number the refusal used --
  not two queries that could disagree.

**"Parses" is not "runs".** No claim is made about what this does to a real `api_keys` table. The
thing to read in the notice output before it drops anything is the count in section 5, and the thing
to read afterwards is section 6: `key_hash` absent, `key_digest` not nullable, no trigger or
function left behind.

## 11. Version number

`20261005310000`. The two files before it in this chain are `20261005290000` (the digest columns
this one drops half of) and `20261005300000` (the owner UPDATE policy the panel's rotation needs).
Together with this file they read in dependency order: 290000, 300000, 310000.

This file was `20261005220000`, and that key was a collision rather than a reservation. It was
chosen to leave a gap for the edge function change, which adds no migration at all -- so the gap
was never used, and in the meantime `fix/bel-249-byline-change-attribution` took the same key with
`20261005220000_story_byline_changes.sql` on an unrelated stack. Two files, one version key, both
targeting `main`. Per section 9, a version-keyed ledger SKIPS a file at a version it has already
recorded, so whichever landed second would have been skipped in silence: had the byline table
landed first, this file would never have dropped the plaintext column; had this landed first, the
byline table would never have been created. No error either way.

Renumbered here rather than in the byline branch because this branch already needed a rebase onto
PR #40's renumbered head, so the edit was free here, and a filename change on a PR whose review is
already closed is a worse thing to ask for than one on a PR that has to be rebased anyway. The
byline branch is untouched.
*/

-- ---------------------------------------------------------------------------------------------
-- 0. Prerequisites: the digest column and its index must already exist.
--
--    This file drops objects created by 20261005290000. Applied to a database where that file was
--    never run, `DROP TRIGGER IF EXISTS` and `DROP FUNCTION IF EXISTS` are silent no-ops, the census
--    below raises "column key_digest does not exist", and the operator is left reading a message
--    about a column when the actual problem is the file above this one. Nothing here is DDL, so
--    raising here means nothing has run.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  has_column boolean;
  has_index boolean;
BEGIN
  SELECT count(*) > 0 INTO has_column
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'api_keys'
     AND column_name = 'key_digest';

  IF NOT has_column THEN
    RAISE EXCEPTION
      'api_keys.key_digest does not exist, so 20261005290000 has not been applied to this database and nothing in this file has run. Apply that file first.';
  END IF;

  -- The unique index is proof the earlier file ran to completion, not just that a column with the
  -- right name is present. Without it nothing enforces that two keys cannot share a digest.
  SELECT count(*) > 0 INTO has_index
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'api_keys'
     AND indexname = 'idx_api_keys_key_digest';

  IF NOT has_index THEN
    RAISE EXCEPTION
      'public.idx_api_keys_key_digest does not exist, so 20261005290000 did not finish on this database and nothing in this file has run. Apply that file first.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. Census, and the refusal.
--
--    Read-only, and it runs before any DDL in this file, so a refusal leaves the database exactly
--    as it was. See section 4 for why the count is here and not in a comment.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  total integer;
  no_digest integer;
  malformed integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE key_digest IS NULL),
         count(*) FILTER (WHERE key_digest IS NOT NULL AND key_digest !~ '^[0-9a-f]{64}$')
    INTO total, no_digest, malformed
    FROM api_keys;

  RAISE NOTICE 'api_keys: % row(s) total, % with no digest, % with a malformed digest.',
    total, no_digest, malformed;

  -- The refusal. A row with no digest cannot be repaired from here: the plaintext that would repair
  -- it is the column this file is about to drop, and the digest is not derivable from anything else.
  IF no_digest > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop api_keys.key_hash: % of % row(s) have no key_digest, and the plaintext that would derive one is the column being dropped. Every one of those keys would stop working permanently and be discovered from a 401. Fill key_digest for those rows first, or revoke them on purpose, and re-apply. Nothing in this file has run.',
      no_digest, total;
  END IF;

  -- Reported, not refused on: the plaintext is still readable at this moment, so the value can be
  -- re-derived, and a digest that was never encode(digest(key_hash, ''sha256''), ''hex'') is a fact
  -- about a writer somebody has not identified yet. Worth reading, not worth blocking on.
  IF malformed > 0 THEN
    RAISE WARNING
      'api_keys: % row(s) hold a key_digest that is not 64 lowercase hex characters. These keys cannot be matched by digest lookup as it stands. The plaintext is still in the table, so the value can be re-derived if this file is not applied yet.',
      malformed;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The trigger, then the function. In that order, and both before the column.
--
--    api_keys_fill_key_digest reads NEW.key_hash. A plpgsql body is parsed at CREATE time and its
--    statements are prepared at call time, so that column reference is not a recorded dependency:
--    DROP COLUMN would succeed with the trigger attached, and the trigger would then raise inside
--    the next writer's transaction. See section 5.
--
--    DROP FUNCTION after DROP TRIGGER is required, not tidiness -- a trigger is a dependent object
--    of its function and PostgreSQL refuses the drop otherwise.
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS api_keys_fill_key_digest ON public.api_keys;

DROP FUNCTION IF EXISTS public.api_keys_fill_key_digest();

-- ---------------------------------------------------------------------------------------------
-- 3. The index on the plaintext column.
--
--    PostgreSQL drops this on its own with the column, as it does the base schema's inline
--    UNIQUE constraint index. Named so a replay is a no-op and so the operator sees both go.
-- ---------------------------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_api_keys_hash;

-- ---------------------------------------------------------------------------------------------
-- 4. The column goes, and the constraint that keeps the column honest lands on its replacement.
--
--    DROP COLUMN IF EXISTS because a version-keyed ledger skips a file it has already recorded
--    rather than rejecting it, so a plain DROP COLUMN would abort on replay with an error that
--    reads like a failed migration. See section 9.
--
--    SET NOT NULL is the structural guard described in section 6. It scans the table under
--    ACCESS EXCLUSIVE; api_keys holds one row per issued key.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE api_keys DROP COLUMN IF EXISTS key_hash;

ALTER TABLE api_keys ALTER COLUMN key_digest SET NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 5. Say what the column is, now that the thing it was derived from is gone.
--
--    The comment from 20261005290000 described a trigger that kept this column equal to
--    digest(key_hash) and named key_hash as the source. Both are now false, and a comment that
--    describes a dropped trigger sends the next reader looking for it.
-- ---------------------------------------------------------------------------------------------
COMMENT ON COLUMN api_keys.key_digest IS
  'Lowercase hex SHA-256 digest of the raw bcn_ key, and the only representation of it this table holds. Not a password hash: the key is 206.8 bits of CSPRNG output, so there is no preimage to search and no salt is used. Written by the client as digest(key_hash) where key_hash was the credential that no longer exists; NOT NULL because nothing derives it in the database and a row without one cannot be matched by any lookup.';

COMMENT ON COLUMN api_keys.key_prefix IS
  'Display value for the human panel list: the bcn_ prefix plus the first eight characters of the key. Never part of the secret, and unaffected by the plaintext being dropped.';

-- ---------------------------------------------------------------------------------------------
-- 6. Post-apply check. Read this after applying, and keep the output.
--
--    The expected shape is: key_hash absent, key_digest not nullable, no digest column that is
--    missing on any row, no trigger and no function left behind, idx_api_keys_hash gone, and
--    authenticated still holding table-level SELECT, INSERT, UPDATE and DELETE. Section 7 is the
--    grant precheck repeated after the fact, because a migration that half-applies is worse than
--    one that refuses.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  total integer;
  malformed integer;
  hash_column text;
  digest_nullable text;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE key_digest !~ '^[0-9a-f]{64}$')
    INTO total, malformed
    FROM api_keys;

  SELECT string_agg(column_name, ', ' ORDER BY column_name)
    INTO hash_column
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'api_keys'
     AND column_name = 'key_hash';

  SELECT is_nullable
    INTO digest_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'api_keys'
     AND column_name = 'key_digest';

  RAISE NOTICE 'api_keys: % row(s) total, % with a malformed digest.', total, malformed;
  RAISE NOTICE 'api_keys: key_hash present = %, key_digest is_nullable = %.',
    hash_column IS NOT NULL, coalesce(digest_nullable, '(no such column)');
  RAISE NOTICE 'api_keys: api_keys_fill_key_digest trigger present = %, function present = %.',
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.api_keys'::regclass AND tgname = 'api_keys_fill_key_digest'),
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'api_keys_fill_key_digest');
  RAISE NOTICE 'api_keys: idx_api_keys_hash present = %.',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'api_keys' AND indexname = 'idx_api_keys_hash');
  RAISE NOTICE 'api_keys: authenticated holds table-level SELECT = %, INSERT = %, UPDATE = %, DELETE = %.',
    (SELECT count(*) > 0 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'api_keys'
        AND grantee = 'authenticated' AND privilege_type = 'SELECT'),
    (SELECT count(*) > 0 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'api_keys'
        AND grantee = 'authenticated' AND privilege_type = 'INSERT'),
    (SELECT count(*) > 0 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'api_keys'
        AND grantee = 'authenticated' AND privilege_type = 'UPDATE'),
    (SELECT count(*) > 0 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'api_keys'
        AND grantee = 'authenticated' AND privilege_type = 'DELETE');
END
$$;