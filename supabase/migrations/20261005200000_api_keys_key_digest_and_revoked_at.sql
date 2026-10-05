/*
# api_keys: store a digest beside the credential, revoke instead of deleting

## 1. Purpose

`api_keys.key_hash` is named for a hash and holds nothing of the kind. The base schema's header
describes the table as "Writer API keys stored as hashes with a display prefix"
(`20261004123918_create_belmont_news_schema.sql:16`) and the column is called `key_hash` (`:223`),
but every writer of it writes the credential:

    src/pages/DashboardPage.tsx:190-196   insert({ ..., key_hash: rawKey, key_prefix: prefix })
    src/pages/DashboardPage.tsx:207-222   update({ key_hash: rawKey, key_prefix: prefix })
    supabase/functions/api/index.ts:41-43 .eq("key_hash", rawKey)

So any read of `api_keys` yields every desk credential in full. The name is the second half of the
defect: the column reads as though it were already safe, so the next person to look at it does not
look again.

This file is additive on purpose. It adds the column the code will read (`key_digest`), converts
every existing row in place, adds `revoked_at`, and adds a trigger that keeps the two
representations in agreement. It does not change the column anything reads today, so nothing breaks
while it is applied. See section 3.

## 2. What this file does NOT do

- It does not change `key_hash`. The plaintext column survives untouched. Removing it is a separate
  file that must land after the function reads `key_digest`, because dropping it earlier is what
  breaks every API call in the system.
- It does not make `key_digest` NOT NULL. See section 4; doing that here would break the deployed
  panel on its next key creation, which is the exact failure the migration-before-frontend rule
  exists to prevent, running in the direction people forget to check.
- It does not change any policy, any trigger on any other table, or any grant.
- It does not invalidate a single key, and it does not rotate anything.

## 3. Why no key has to be rotated

"Hashing an unhashed key column" sounds like it orphans every existing key. It does not, because at
the moment this migration runs the plaintext is sitting in `key_hash` and is available to the
migration itself (step 3). Each existing row is converted from its own stored value.

A key issued before this file and a key issued after it are both looked up the same way from the
moment the function switches over. Nobody is handed a replacement credential and no publish is
delayed. There is exactly one rotation left in this system and it is the one the board already
ordered on BEL-18: rotate the exposed token, then publish. This change does not add a second one.

## 4. The window this file creates, and why `key_digest` stays nullable

For a period the database carries both representations of every key: `key_hash` (the credential)
and `key_digest` (its SHA-256). That window exists because two writers still have to keep working
across it:

- the **deployed** panel, which sends `key_hash` and has never heard of `key_digest`
- the **deployed** edge function, which looks up `.eq("key_hash", rawKey)`

`key_digest` is nullable here. **The reason is that it must be, not that it is safer.**

- `ALTER TABLE api_keys ADD COLUMN key_digest text NOT NULL` with no `DEFAULT` is refused outright on
  a table that already has rows: `23502 column "key_digest" contains null values`. Verified. So the
  constraint could not be applied in step 1 in the first place, whatever the trigger does.
- The trigger in step 2 does make `NOT NULL` *satisfiable* later — PostgreSQL evaluates a NOT NULL
  constraint **after** BEFORE-row triggers, so an insert naming only `key_hash` into a
  `key_digest text NOT NULL` column is accepted and the digest is filled first.

So the constraint is worth having once the trigger is proven, and it moves to the migration that drops
`key_hash` (BEL-283). What this file must not do is claim the deployed panel would be broken by it.
**An earlier draft of this file said exactly that and was wrong** — corrected here after it was run
against a real PostgreSQL. See section 5.

The honest reason to keep the column nullable in the meantime is that a NULL digest is the *silent*
failure mode. Section 5 checks for it after applying.

Against the comparison the base schema offers, `key_hash` is `text NOT NULL UNIQUE` with no default:
this file matches it on uniqueness and on the absence of a default, and deliberately not on NOT NULL
timing.

`revoked_at` is nullable for the same reason plus the obvious one: `NULL` means the key is live, and
every existing row is live.

## 5. The trigger is what makes the window safe

`api_keys_fill_key_digest` keeps `key_digest` equal to `digest(key_hash)` for **any** writer -- the
old panel, PostgREST, curl, a future migration -- without any of them having to know `key_digest`
exists. Two properties follow, and both are the point:

- A key created by the old panel *after* this file is applied is still found by the new function.
  Without the trigger it would carry a NULL digest and the new function would refuse a credential
  that demonstrably exists.
- When the old panel rotates (`update({ key_hash: rawKey })`) the digest is recomputed from the new
  plaintext. Without the trigger the row would end up holding a digest of the *old* key beside the
  *new* plaintext, which is the worst possible shape: the new function silently refuses a key that
  was just issued, and the reason is not visible from either column.

So the two representations never disagree, and the edge function may be switched from `key_hash`
to `key_digest` at any point, in either direction, with no key breaking in between.

The trigger runs `SECURITY INVOKER` and may only ever *fill* a column. It cannot remove a privilege
or widen one, so unlike a narrowed grant it cannot half-apply.

**One correction to this section, because the first version of it described a bug that does not
occur.** The rotation branch above is insurance for a *future* UPDATE policy, not a repair of a live
gap. `api_keys` carries RLS policies for SELECT, INSERT and DELETE (base schema `:232-245`) and
**none for UPDATE**, across all nine migrations in the repository. Replayed as `authenticated`, which
is how the panel connects, `handleRerollKey`'s `.update({ key_hash, key_prefix }).eq('id', keyId)`
changes **0 rows** and supabase-js returns `{ data: null, error: null }` -- the code only inspects
`error`, so the button that promises *"The old key will stop working immediately"* reports success
and the old key keeps working.

That is a live defect in its own right, in the blast radius of BEL-273 and tracked separately. It is
named here because it is why the digest-of-the-old-key shape cannot occur **yet**, and a reader
checking this branch deserves to know that. The branch becomes live the moment an UPDATE policy
exists, which is when it will start earning its place.

## 6. Read this before applying: the grant precheck

This file adds two columns and expects `authenticated` to keep writing its own rows while it does
not know those columns exist. That works automatically **if** `authenticated`'s privileges on
`api_keys` are table-level. Check rather than assume: if they are column-scoped, the **read side**
stops working, and the story-facing site keeps rendering normally because it never touches this
table.

One correction to the reason, because the first version of this file gave the wrong one. It said the
trigger's column read would fail. **A BEFORE-row trigger reads `NEW`/`OLD` from the row image, and
PostgreSQL does not check column privileges on them.** Verified: with table-level `INSERT` granted and
`SELECT` revoked entirely, the trigger still inserted and filled the digest correctly.

The hazard under column-scoped grants is on the read side — `select *` and any named `key_digest`
read are refused — and that refusal already exists today for the current columns, so a column-scoped
`api_keys` would have broken the panel before this file ever ran. The stop instruction below is
rightly cautious; it is aimed at a condition whose symptom would predate the change.

Run this first:

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

The expected answer is `insert_is_table_level = true` and `select_is_table_level = true`, with
`insert_column_scope` and `select_column_scope` listing every column.

Two traps when reading the result:

- A table-level grant is reported in `column_privileges` as well, expanded to one row per column. A
  populated `*_column_scope` is therefore **not** by itself evidence of a narrow grant. Compare
  `table_privileges` against `column_privileges` for the same grantee and privilege, exactly as
  `20261005190000_profiles_role_not_self_assignable.sql` section 4 does, or this check reads as a
  false alarm.
- The table owner appears in these views with its implicit privileges whether or not anything was
  ever granted, so scope the query to `grantee = 'authenticated'`.

If either `*_is_table_level` comes back `false`, **stop and do not apply this file.** The fix is a
separate migration extending the existing column grants to cover `key_digest` and `revoked_at` for
`SELECT`, `INSERT`, `UPDATE` and `DELETE`. Do not widen a grant to a public role to get past this,
and do not edit this file to add a `GRANT`: a narrowed grant that half-applies leaves the panel
writing blind, which is worse than not shipping.

This file adds no grant of its own. Across every migration in this repository the only `GRANT` or
`REVOKE` is on `public.comments_public` (`20261005160000_comments_public_view.sql:102-103`), and
`20261005140000_weather_forecasts_deferred_fields.sql:180` leaves its own grant block commented out
on purpose. There is no column-scoped grant on `api_keys`, which is why section 6 expects
table-level privileges to be the thing that is already true.

**No agent on this beat can run this precheck or apply the file.** The installed Supabase connection
points at the Shipwright project, not Belmont News (BEL-48). Applying it is a human action in the
Supabase dashboard, and it has not been applied.

## 7. Why SHA-256, and why no salt and no slow KDF

`key_digest` is the SHA-256 digest of the raw `bcn_...` key, lowercase hex, no prefix -- the same
digest `crypto.subtle.digest('SHA-256', ...)` produces over the UTF-8 bytes of the key in the
browser. The casing and the absence of a prefix are load-bearing; a mismatch fails closed, because
no row matches and the caller is refused rather than let in.

No salt and no password KDF. The key space is `log2(36^40) = 206.8` bits of CSPRNG output (the
CSPRNG change on BEL-273), so there is no preimage worth searching: recovering a key from its digest
means searching 2^207 candidates, which is not a computation anybody performs or can. A slow KDF such
as bcrypt or argon2 is right for a human-chosen password and wrong here -- it buys nothing against
that and it would put a deliberately expensive hash in the path of every API request.

## 8. `revoked_at`: revoke, do not delete

`handleDeleteKey` hard-deletes the row today (`DashboardPage.tsx:225-230`). A hard delete cannot
answer either question the desk actually has: whether a key that stopped working was revoked on
purpose or was never issued at all, and whether anything was still calling a key after the moment it
was meant to be gone. `last_used_at` records the last call and survives an update, so `revoked_at`
beside it is the window -- a key revoked on the 5th whose `last_used_at` is the 9th was still in use
after it was revoked.

The edge function change that honours `revoked_at` is a separate file, sequenced after this one.
Adding the column before anything reads it is the safe order; adding a column nothing reads breaks
nothing.

## 9. Rerunnable

`ADD COLUMN IF NOT EXISTS`, a backfill guarded on `IS NULL`, `DROP TRIGGER IF EXISTS` before
`CREATE TRIGGER`, and `CREATE INDEX IF NOT EXISTS` are each safe to run again against a database
where this file has already been applied.

The `DROP TRIGGER IF EXISTS` is not tidiness. A version-keyed migration ledger **skips** a file at a
version it has already recorded rather than rejecting it, so a replayed file is silent, and
`CREATE TRIGGER` without a preceding drop aborts on the second run (BEL-180, PR #27). Every
`CREATE` in this file that is not `IF NOT EXISTS` is preceded by its drop.

This file has **not** been applied to Belmont News. No agent on this beat can reach that database:
the installed Supabase connection points at the Shipwright project, not Belmont News (BEL-48).
Applying it is a human action in the Supabase dashboard, and section 6 still has to be run for real
first.

It **has** been run, against a scratch PostgreSQL 18.1 with a faithful copy of `api_keys` -- the same
table definition, the same three owner-scoped RLS policies, the same grant shape, three desk keys
with plaintext in `key_hash`. 12 behavioural assertions, all passing:

    PASS  old-panel INSERT (names key_hash only) succeeds                                    1 row(s)
    PASS  the trigger filled key_digest from the plaintext                    got 41900ecc1df289cc… want 41900ecc1df289cc…
    PASS  key_hash still holds the plaintext (the column is not dropped yet)
    PASS  handleRerollKey as `authenticated` silently changes 0 rows         rowCount=0  (BEL-281 N3)
    PASS  reroll as service_role: digest recomputed to the NEW plaintext    rows changed: 1
    PASS  last_used_at-only UPDATE leaves the digest alone
    PASS  revoked_at is settable and the row survives rather than being deleted
    PASS  every un-revoked row resolves by its own digest (no key orphaned)                3 row(s)
    PASS  select(*) STILL returns the plaintext column -- this file leaves that open
    PASS  the narrowed column list works and omits both secret and digest columns
    PASS  rerunnable: second and third apply are clean no-ops                       rows 4 -> 4
    PASS  section 6 precheck: table-level, and column scope includes both new columns

What that harness caught, which reading the file did not:

- **The INSERT branch used a bare `key_hash`** under the `search_path = pg_catalog, pg_temp` the same
  function sets, so it resolved against nothing: `42703 column "key_hash" does not exist`, on every
  key the desk creates. Found by Sam Oyelaran on BEL-281. This file's own step-5 check could not see
  it -- the migration applied cleanly and reported a clean bill of health, and only the *write* failed.
  That is the silent direction a migration half-applies in, and it is the reason the assertion above
  exists.
- **`pg_get_function_identity_arguments(p.oid) = 'text, text'` matched nothing** when `digest` is
  declared with named parameters -- it returns `data text, how text`, not `text, text`. This was mine,
  found by the harness an hour later, and it is the more embarrassing of the two: the entire reason
  this file resolves the function instead of writing `extensions.digest` is to carry no assumption
  nobody can check from here, and a name-sensitive match put the assumption straight back. Now
  `oidvectortypes`, which reports types only. The preflight refuses cleanly with nothing applied.
- The two wrong claims in sections 4 and 6 above, corrected against the engine rather than argued.

Reverted-to-pre-fix copies of both defects were run against the same fixture to confirm the harness
actually fails on them, because a test that passes on the broken version is worth nothing: the bare
`key_hash` variant applies cleanly and then fails the insert with 42703, and the
`pg_get_function_identity_arguments` variant is refused by the preflight with nothing applied.

Two limits worth stating plainly:

- The scratch server stands in for `pgcrypto`. `extensions.digest(text, text)` is a local
  implementation backed by the built-in `sha256(bytea)`, which is the *shape* the preflight resolves
  for, so the resolution logic was exercised -- the actual extension was not present.
- This establishes engine behaviour on a fixture. It is not the state of the Belmont News database.
  Section 6 has to be run against the real grants before anyone applies this.
*/

-- ---------------------------------------------------------------------------------------------
-- 0. Preflight: pgcrypto must be reachable, and nothing has run yet when this fails.
--
--    The hash is computed in the database because the plaintext only exists there. Computing it in
--    the application instead would mean walking every row from a client or from the edge function
--    and converting rows as their owners happened to visit the panel, which leaves plaintext at
--    rest for an unbounded time and is not reproducible.
--
--    The function is resolved rather than assumed. Supabase installs pgcrypto into `extensions`, a
--    plain PostgreSQL install puts it in `public`, and no agent on this beat can look to find out
--    which this database is (BEL-48). Resolving `digest(text, text)` in whichever schema holds it
--    means this file does not depend on an answer nobody has verified.
--
--    The match is on `oidvectortypes(p.proargtypes)`, NOT on
--    `pg_get_function_identity_arguments(p.oid) = 'text, text'`. That looked equivalent and is not:
--    identity_arguments keeps the declared parameter names, so a `digest` defined as
--    `digest(data text, how text)` reports `data text, how text` and matches nothing. Verified on
--    PostgreSQL 18.1 against both spellings:
--
--        proname         identity_args     oidvectortypes
--        digest(text,text)  text, text       text, text
--        digest(a text, b text)  a text, b text   text, text
--
--    pgcrypto happens to declare its own `digest` with unnamed parameters, so the string form
--    probably works on Supabase today -- "probably" is the problem. The whole reason this file
--    resolves the function instead of writing `extensions.digest` is to carry no assumption nobody
--    can check from here, and a name-sensitive match puts the assumption back. `oidvectortypes`
--    reports types only, so it is unaffected by parameter names and still rejects the
--    `digest(bytea, text)` overload.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  resolved text;
BEGIN
  SELECT format('%I.digest', n.nspname)
    INTO resolved
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'digest'
     AND n.nspname <> 'pg_catalog'
     AND oidvectortypes(p.proargtypes) = 'text, text'
   ORDER BY n.nspname
   LIMIT 1;

  IF resolved IS NULL THEN
    RAISE EXCEPTION
      'pgcrypto digest(text, text) was not found in any non-system schema, and nothing in this file has run. Install it and re-apply: CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;';
  END IF;

  -- Prove it is callable, not merely present. A signature that resolves but raises on call would
  -- otherwise first be discovered by the backfill in step 2, after the columns already exist.
  EXECUTE format('SELECT %s($1, $2)', resolved) USING 'preflight', 'sha256';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. The two new columns, both nullable.
--
--    Nullable is load-bearing here, not laziness. See section 4: the deployed panel does not name
--    key_digest, and NOT NULL would break its next key creation. revoked_at is nullable because
--    NULL is the live case and every existing row is live.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_digest text;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- 2. Convert every existing row from its own stored plaintext, and install the trigger that keeps
--    the two representations in agreement.
--
--    The backfill is `WHERE key_digest IS NULL` so it is a no-op on a re-run. Rows the old panel
--    inserts after this file is applied are handled by the trigger, not by a second backfill.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  resolved text;
  converted integer;
BEGIN
  SELECT format('%I.digest', n.nspname)
    INTO resolved
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'digest'
     AND n.nspname <> 'pg_catalog'
     AND oidvectortypes(p.proargtypes) = 'text, text'
   ORDER BY n.nspname
   LIMIT 1;

  EXECUTE format(
    'UPDATE api_keys
        SET key_digest = encode(%s(key_hash, %L), %L)
      WHERE key_digest IS NULL',
    resolved, 'sha256', 'hex'
  );
  -- GET DIAGNOSTICS is its own statement and reads ROW_COUNT from the one before it. It cannot be
  -- chained onto EXECUTE.
  GET DIAGNOSTICS converted = ROW_COUNT;

  RAISE NOTICE 'api_keys: converted % row(s) to key_digest.', converted;

  -- The function is built with EXECUTE rather than CREATE FUNCTION so that the digest call inside
  -- it is schema-qualified to the schema resolved above. A plpgsql body is parsed at CREATE time
  -- but its statements are prepared at call time, so leaving the call unqualified would resolve it
  -- against whatever search_path the writing role happens to have -- which for a PostgREST request
  -- is not the schema this file found it in.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION public.api_keys_fill_key_digest()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.key_digest IS NULL AND NEW.key_hash IS NOT NULL THEN
          -- `NEW.key_hash`, never a bare `key_hash`. This function sets
          -- search_path = pg_catalog, pg_temp, so an unqualified column name resolves against
          -- nothing and the statement fails with SQLSTATE 42703 -- on the INSERT branch only,
          -- which is every key the desk creates. See section 5.
          NEW.key_digest := encode(%1$s(NEW.key_hash, 'sha256'), 'hex');
        END IF;
      ELSE
        -- The plaintext moved, so the digest has to follow it. This is the case that keeps the old
        -- panel's reroll from leaving a row whose digest describes the previous key.
        IF NEW.key_hash IS DISTINCT FROM OLD.key_hash THEN
          NEW.key_digest := encode(%1$s(NEW.key_hash, 'sha256'), 'hex');
        ELSIF NEW.key_digest IS NULL THEN
          NEW.key_digest := encode(%1$s(NEW.key_hash, 'sha256'), 'hex');
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$;
  $ddl$, resolved);

  -- Dropped before created, so a replay does not abort. See section 9.
  EXECUTE 'DROP TRIGGER IF EXISTS api_keys_fill_key_digest ON public.api_keys';

  EXECUTE $ddl$
    CREATE TRIGGER api_keys_fill_key_digest
      BEFORE INSERT OR UPDATE ON public.api_keys
      FOR EACH ROW
      EXECUTE FUNCTION public.api_keys_fill_key_digest();
  $ddl$;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Indexes.
--
--    The unique index is what the edge function's lookup becomes. idx_api_keys_hash stays because
--    key_hash still holds the credential and is still what the deployed function reads; it is
--    dropped by the follow-up file, with the column.
--
--    The partial index supports "which keys were revoked, and when", which is the query the audit
--    window in section 8 is made of. Partial because revoked keys stay a small minority forever.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_digest ON api_keys (key_digest);

CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at
  ON api_keys (revoked_at)
  WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Say what is in each column, for as long as each column exists.
--
--    The column name already misleads. These make the description next to it say what is actually
--    there, in \d api_keys, in any schema dump, and in the Supabase dashboard. The key_hash note is
--    the last chance to say it before the column is dropped.
-- ---------------------------------------------------------------------------------------------
COMMENT ON COLUMN api_keys.key_digest IS
  'Lowercase hex SHA-256 digest of the raw bcn_ key. Not a password hash: the key is 206.8 bits of CSPRNG output, so there is no preimage to search and no salt is used. Kept equal to digest(key_hash) by the api_keys_fill_key_digest trigger. NULL only for a row written by something that bypassed the trigger.';

COMMENT ON COLUMN api_keys.revoked_at IS
  'When this key stopped authorising calls. NULL means the key is live. A key is revoked, not deleted, so the row survives as evidence and last_used_at can be compared against this.';

COMMENT ON COLUMN api_keys.key_hash IS
  'DEPRECATED. Holds the RAW credential, not a hash, despite this name. Read it and you hold every desk key in full. It survives only until the edge function reads key_digest; a follow-up migration drops this column and its index. Do not add a reader for it. Do not widen any grant to include it.';

-- ---------------------------------------------------------------------------------------------
-- 5. Post-apply check. Read this after applying, and keep the output.
--
--    The expected shape is one row per key, key_digest 64 lowercase hex characters, and
--    key_digest equal to the SHA-256 of the key_hash still sitting beside it. A malformed digest
--    means the function resolved above is not the one the browser will compute with, and
--    authentication will fail closed rather than open. A row with no digest is not a failure: it is
--    a row written by something that bypassed the trigger, and it is counted rather than raised on
--    because a NULL digest is the legitimate state of the transition window (section 4).
--
--    The grant read is section 6 repeated after the fact, because a migration that half-applies is
--    worse than one that refuses.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  resolved text;
  total integer;
  no_digest integer;
  bad_length integer;
  disagreeing integer;
BEGIN
  -- Resolved again, and qualified again, for the same reason as steps 0 and 2: an unqualified
  -- `digest(...)` here would resolve against this session's search_path rather than against the
  -- schema pgcrypto is actually installed in, and the post-apply check would fail on a database
  -- where the migration itself had succeeded.
  SELECT format('%I.digest', n.nspname)
    INTO resolved
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'digest'
     AND n.nspname <> 'pg_catalog'
     AND oidvectortypes(p.proargtypes) = 'text, text'
   ORDER BY n.nspname
   LIMIT 1;

  EXECUTE format(
    'SELECT count(*),
            count(*) FILTER (WHERE key_digest IS NULL),
            count(*) FILTER (WHERE key_digest IS NOT NULL AND key_digest !~ %L),
            count(*) FILTER (WHERE key_digest IS NOT NULL AND key_digest
                              IS DISTINCT FROM encode(%s(key_hash, %L), %L))
       FROM api_keys',
    '^[0-9a-f]{64}$', resolved, 'sha256', 'hex'
  )
  INTO total, no_digest, bad_length, disagreeing;

  RAISE NOTICE 'api_keys: % row(s) total, % with no digest, % with a malformed digest, % whose digest disagrees with key_hash.',
    total, no_digest, bad_length, disagreeing;
  RAISE NOTICE 'api_keys: authenticated holds table-level INSERT = %, UPDATE = %.',
    (SELECT count(*) > 0 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'api_keys'
        AND grantee = 'authenticated' AND privilege_type = 'INSERT'),
    (SELECT count(*) > 0 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'api_keys'
        AND grantee = 'authenticated' AND privilege_type = 'UPDATE');
END
$$;
-- ---------------------------------------------------------------------------------------------
-- 6. Tell PostgREST the schema changed.
--
--    Supabase's PostgREST serves column lists from a schema cache, and it reloads that cache from a
--    notification. When the notification queue fails to deliver, the cache goes stale silently and
--    the first request naming the new column fails with PGRST204 while the SQL above is perfectly
--    happy. This repository has been bitten by exactly that:
--    `20261005150000_author_profiles_fk.sql:24` records a PGRST200.
--
--    There is no effect on the panel today, because its insert does not name `key_digest` -- the
--    trigger fills it. It matters at the step that does: BEL-282 switches
--    `api/index.ts:41-43` from `.eq("key_hash", ...)` to `.eq("key_digest", ...)`, and that request
--    goes through PostgREST via supabase-js. It is cheaper to send the signal now than to diagnose a
--    PGRST204 later.
--
--    Sent bare, with no guard, and that is deliberate. A first draft wrapped this in a DO block with
--    an exception handler, on the theory that NOTIFY to a channel nobody is listening on would abort
--    the migration on its last statement. It does not: a channel is created on demand by LISTEN, and
--    NOTIFY is fire-and-forget. Verified -- `NOTIFY pgrst, 'reload schema'` on a server with no
--    listener completes without raising, and the handler never fires. The guard was dead code
--    defending against a failure that cannot happen, so it is gone rather than kept as comfort.
-- ---------------------------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
