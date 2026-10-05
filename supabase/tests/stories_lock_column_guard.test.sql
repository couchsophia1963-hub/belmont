-- ============================================================
-- Landing test: stories_guard_lock_columns (BEL-213)
--
-- Run this AFTER applying 20261005123424_20261005180000_story_locking.sql and
-- 20261005200000_stories_lock_column_guard.sql, and run step 1 of the migration
-- header before you apply anything at all.
--
-- It is safe on the live project. Everything runs inside one transaction that
-- ROLLBACKs, so it creates and destroys its own fixtures and leaves no row, no
-- policy and no grant behind. Paste the whole file into the Supabase SQL editor
-- and run it as one statement.
--
-- What a pass means
-- -----------------
-- The guard is present AND it fires. Both halves matter and they fail differently:
-- a trigger that does not exist is a missing control, and a trigger that exists but
-- does not fire is worse, because it reads as a fix. That is why every refusal below
-- is asserted twice, once on the error and once on the row afterwards. A statement
-- that is silently filtered by RLS raises nothing and matches zero rows, so an
-- assertion that only checks "did it throw" would pass on a guard that does nothing.
--
-- What it does not prove
-- ----------------------
-- It does not prove anything about the Belmont News database's own grants. Step 1
-- is the live read for that, and it is a separate query on purpose: this file tests
-- behaviour under emulated roles, step 1 reads reality.
--
-- It does not test service_role as a trust decision. That the guard lets
-- service_role through is documented, disclosed residual trust rather than an
-- oversight, and it is asserted here only so a change to the guard that silently
-- started refusing service_role would break the edge function and be noticed.
--
-- Role switching in the SQL editor
-- --------------------------------
-- `set local role authenticated` works from the SQL editor because that session is
-- `postgres`, which may assume any role. The claim GUCs are set with
-- `request.jwt.claims`, which is the modern form Supabase's own auth.uid() reads.
-- The legacy `request.jwt.claim.sub` is also set so the file works on a project
-- running the older accessor. Everything is `local`, so it is scoped to this
-- transaction and cannot leak into the next statement.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------------------------
-- 0. The guard must already exist. If this reports zero rows, the migration did not install and
--    nothing below means anything. This is the assertion that catches "db push reported success
--    but skipped the file", which is what a version collision in supabase_migrations does.
-- ---------------------------------------------------------------------------------------------
create temporary table bel213_results (
  step text primary key,
  expected text not null,
  got text not null,
  passed boolean not null
) on commit drop;

-- Sections 4a to 4d run the whole admin sequence under `set local role authenticated`, so the
-- assertions are recorded by the same role whose behaviour they are asserting. Without this the
-- first insert fails with `permission denied for table bel213_results` and the whole file aborts.
-- This is the only grant this file makes, it is on a temporary table that disappears with the
-- transaction, and it grants nothing on any application table.
grant insert, select on bel213_results to authenticated, anon, service_role;

insert into bel213_results (step, expected, got, passed)
select '0. trigger installed and enabled',
       '1 row, tgenabled = O',
       count(*)::text || ' row(s), tgenabled = ' || coalesce(min(tgenabled), '(none)'),
       count(*) = 1 and bool_and(tgenabled = 'O')
  from pg_trigger
 where tgrelid = 'public.stories'::regclass
   and not tgisinternal
   and tgname = 'stories_guard_lock_columns';

-- ---------------------------------------------------------------------------------------------
-- 1. Rule 3, the live read, corrected. Run this before applying anything, not after.
--
--    Expected: update_is_table_level = true, columns_with_explicit_acl = 0, and `locked`
--    present in update_columns.
--
--    Do NOT use the row count of information_schema.column_privileges for this. Its first
--    UNION branch explodes the table ACL and pairs it with every column, so a table-level
--    grant is reported once per column and the table owner appears with implicit
--    privileges regardless. Measured against a real PostgreSQL engine, it returns 16 rows
--    for `stories` on a database with nothing column-scoped. An earlier revision of the
--    migration header used it and told the reader that any row meant STOP.
-- ---------------------------------------------------------------------------------------------
select
  (select count(*) > 0
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'stories'
      and grantee = 'authenticated' and privilege_type = 'UPDATE')
    as update_is_table_level,
  (select coalesce(string_agg(column_name, ', ' order by column_name), '(none)')
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'stories'
      and grantee = 'authenticated' and privilege_type = 'UPDATE')
    as update_columns,
  (select count(*)
     from pg_attribute
    where attrelid = 'public.stories'::regclass
      and attnum > 0 and not attisdropped and attacl is not null)
    as columns_with_explicit_acl,
  -- `locked` must be inside the grant UPDATE already has, or every writer edit fails after
  -- the trigger installs. A trigger refuses a row; it cannot grant the privilege back.
  (select bool_or(column_name = 'locked')
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'stories'
      and grantee = 'authenticated' and privilege_type = 'UPDATE')
    as locked_is_writable_by_authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Fixtures. Two accounts and two stories, all inside this transaction.
--
--    The profiles rows are created by the on_auth_user_created trigger, then the role is
--    set here as `postgres`, which is the server-side path BEL-224's guard allows. Setting a
--    role as an ordinary user is refused, and correctly so.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'bel213-writer@invalid.test'),
  ('22222222-2222-4222-8222-222222222222', 'bel213-admin@invalid.test');

update public.profiles set role = 'writer' where id = '11111111-1111-4111-8111-111111111111';
update public.profiles set role = 'admin'  where id = '22222222-2222-4222-8222-222222222222';

insert into public.stories (id, title, slug, excerpt, body, published, locked) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'BEL-213 open story',   'bel213-open',   'e1', 'b1', true,  false),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'BEL-213 locked story', 'bel213-locked', 'e2', 'b2', true, true);

-- ---------------------------------------------------------------------------------------------
-- 3. The test that matters. As a WRITER, the lock must not move.
--
--    Each refusal is asserted by catching the error in a nested block. SQL has no
--    try/catch outside plpgsql, so each case runs as a DO block that records the outcome
--    rather than aborting the whole transaction on the first refusal.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  before_locked boolean;
  before_published boolean;
  got text;
  changed_to boolean;
  locked_until_is_null boolean;
  n integer;
begin
  ---------------------------------------------------------------------------------------------
  -- 3a. WRITER cannot LOCK an open story. This is the reported gap: before
  --     20261005200000, this statement succeeded and the delete policy then admitted the
  --     delete.
  ---------------------------------------------------------------------------------------------
  select locked into before_locked from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '11111111-1111-4111-8111-111111111111';
    set local request.jwt.claims     = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
    update public.stories set locked = true
     where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    got := 'no error';
  exception when others then
    got := sqlstate;
  end;
  reset role;
  select locked into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  insert into bel213_results (step, expected, got, passed) values
    ('3a. WRITER cannot lock an open story',
     'refused 42501, row still unlocked',
     got || ', locked = ' || changed_to::text,
     got = '42501' and changed_to = before_locked);

  ---------------------------------------------------------------------------------------------
  -- 3b. WRITER cannot UNLOCK a locked story. The other direction, and the one that
  --     matters most: an unlocked locked-story is a locked story an admin can delete.
  ---------------------------------------------------------------------------------------------
  select locked into before_locked from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '11111111-1111-4111-8111-111111111111';
    set local request.jwt.claims     = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
    update public.stories set locked = false
     where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error';
  exception when others then
    got := sqlstate;
  end;
  reset role;
  select locked into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  insert into bel213_results (step, expected, got, passed) values
    ('3b. WRITER cannot unlock a locked story',
     'refused 42501, row still locked',
     got || ', locked = ' || changed_to::text,
     got = '42501' and changed_to = before_locked);

  ---------------------------------------------------------------------------------------------
  -- 3c. WRITER cannot CLEAR locked_until. NULL -> NULL is not a change, and the guard is
  --     written on IS DISTINCT FROM, so seed a real value as an admin first or this case
  --     passes vacuously. That vacuous pass is the bug an earlier draft of this file had.
  ---------------------------------------------------------------------------------------------
  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '22222222-2222-4222-8222-222222222222';
    set local request.jwt.claims     = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
    update public.stories set locked_until = '2030-01-01T00:00:00Z'
     where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  exception when others then
    null;
  end;
  reset role;

  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '11111111-1111-4111-8111-111111111111';
    set local request.jwt.claims     = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
    update public.stories set locked_until = null
     where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    got := 'no error';
  exception when others then
    got := sqlstate;
  end;
  reset role;
  select (locked_until is null) into locked_until_is_null from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  insert into bel213_results (step, expected, got, passed) values
    ('3c. WRITER cannot clear locked_until',
     'refused 42501, locked_until still set',
     got || ', locked_until is null = ' || locked_until_is_null::text,
     got = '42501' and locked_until_is_null = false);

  ---------------------------------------------------------------------------------------------
  -- 3d. WRITER can still edit content. The guard that refuses everything is broken too,
  --     and it would break the Story Manager for the people it is meant to serve.
  ---------------------------------------------------------------------------------------------
  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '11111111-1111-4111-8111-111111111111';
    set local request.jwt.claims     = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
    update public.stories set title = 'BEL-213 edited by writer', body = 'edited'
     where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    got := 'no error';
  exception when others then
    got := sqlstate;
  end;
  reset role;
  select count(*) into n from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000001' and title = 'BEL-213 edited by writer';
  insert into bel213_results (step, expected, got, passed) values
    ('3d. WRITER can still edit content',
     'succeeds, 1 row edited',
     got || ', ' || n::text || ' row(s) edited',
     got = 'no error' and n = 1);

  ---------------------------------------------------------------------------------------------
  -- 3e. WRITER cannot UNPUBLISH a locked story. The second rule in the migration, beyond
  --     the literal ask on BEL-213: a lock a writer can switch off with the publish
  --     checkbox is not a lock, because the story leaves the site.
  ---------------------------------------------------------------------------------------------
  select published into before_published from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '11111111-1111-4111-8111-111111111111';
    set local request.jwt.claims     = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
    update public.stories set published = false
     where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error';
  exception when others then
    got := sqlstate;
  end;
  reset role;
  select published into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  insert into bel213_results (step, expected, got, passed) values
    ('3e. WRITER cannot unpublish a locked story',
     'refused 42501, row still published',
     got || ', published = ' || changed_to::text,
     got = '42501' and changed_to = before_published);

  ---------------------------------------------------------------------------------------------
  -- 3f. WRITER can still unpublish an UNLOCKED story. Not the gap, and a guard that
  --     refused it would be a behaviour change nobody asked for.
  ---------------------------------------------------------------------------------------------
  begin
    set local role authenticated;
    set local request.jwt.claim.sub  = '11111111-1111-4111-8111-111111111111';
    set local request.jwt.claims     = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
    update public.stories set published = false
     where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    got := 'no error';
  exception when others then
    got := sqlstate;
  end;
  reset role;
  select published into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  insert into bel213_results (step, expected, got, passed) values
    ('3f. WRITER can still unpublish an UNLOCKED story',
     'succeeds, published = false',
     got || ', published = ' || changed_to::text,
     got = 'no error' and changed_to = false);

  ---------------------------------------------------------------------------------------------
  -- 3g. ANON matches zero rows. No UPDATE policy is scoped TO anon, so RLS filters the
  --     statement and it does NOT raise. Asserting "it threw" here would pass on a
  --     completely absent guard.
  ---------------------------------------------------------------------------------------------
  select locked into before_locked from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  begin
    set local role anon;
    set local request.jwt.claims = '{"role":"anon"}';
    update public.stories set locked = false
     where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error';
    get diagnostics n = row_count;
  exception when others then
    got := sqlstate;
    n := -1;
  end;
  reset role;
  select locked into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  insert into bel213_results (step, expected, got, passed) values
    ('3g. ANON update matches 0 rows, no exception',
     'no error, 0 rows affected, row untouched',
     got || ', ' || n::text || ' row(s), locked = ' || changed_to::text,
     got = 'no error' and n = 0 and changed_to = before_locked);

  ---------------------------------------------------------------------------------------------
  -- 3h. service_role passes. Asserted so that a guard change which began refusing
  --     service_role would break the edge function and show up here rather than in
  --     production. It is a disclosure, not an endorsement: a holder of that key can
  --     still change `locked`.
  --
  --     The claim GUCs are CLEARED here, and this is not tidiness. The whole file is one
  --     transaction, and `set local` survives to the end of a transaction, so a case that
  --     does not set its own claims inherits the previous case's identity. Without the
  --     clear, this case still carried 3f's writer `sub`, the guard correctly refused a
  --     non-admin, and the assertion failed. On real Supabase each PostgREST request is
  --     its own transaction, so this leak cannot happen there -- which is exactly why it
  --     has to be handled here or the file lies about the server.
  ---------------------------------------------------------------------------------------------
  begin
    set local role service_role;
    set local request.jwt.claim.sub = '';
    set local request.jwt.claims    = '{"role":"service_role"}';
    update public.stories set locked = false
     where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error';
    get diagnostics n = row_count;
  exception when others then
    got := sqlstate;
    n := -1;
  end;
  reset role;
  select locked into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  insert into bel213_results (step, expected, got, passed) values
    ('3h. service_role passes the guard (disclosed residual trust)',
     'succeeds, 1 row, locked flips to false',
     got || ', ' || n::text || ' row(s), locked = ' || changed_to::text,
     got = 'no error' and n = 1 and changed_to = false);

  ---------------------------------------------------------------------------------------------
  -- 3i. psql / the SQL editor passes, as `postgres`. Deliberate: if the trigger also
  --     refused here, the only way to clear a bad lock would be to drop the trigger.
  --
  --     Claims cleared for the same reason as 3h, and this case depends on it. 3h leaves
  --     the story at locked = false, so this flips it back to true and is a real change.
  --     While the leftover writer `sub` was still in place this statement was a no-op on
  --     an already-locked row and passed without the guard ever being consulted.
  ---------------------------------------------------------------------------------------------
  set local request.jwt.claim.sub = '';
  set local request.jwt.claims    = '';
  begin
    update public.stories set locked = true
     where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error';
    get diagnostics n = row_count;
  exception when others then
    got := sqlstate;
    n := -1;
  end;
  select locked into changed_to from public.stories
   where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  insert into bel213_results (step, expected, got, passed) values
    ('3i. operator (psql / SQL editor) can repair a lock',
     'succeeds, 1 row, locked flips to true',
     got || ', ' || n::text || ' row(s), locked = ' || changed_to::text,
     got = 'no error' and n = 1 and changed_to = true);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. ADMIN is not broken by the guard. All four transitions, because a guard that refuses
--    the admin is a guard that stops the Story Manager working for the people who own it.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  got text;
  n integer;
begin
  set local role authenticated;
  set local request.jwt.claim.sub  = '22222222-2222-4222-8222-222222222222';
  set local request.jwt.claims     = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

  begin
    update public.stories set locked = true where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    got := 'no error'; get diagnostics n = row_count;
  exception when others then got := sqlstate; n := -1; end;
  insert into bel213_results (step, expected, got, passed) values
    ('4a. ADMIN can lock', 'succeeds, 1 row', got || ', ' || n::text, got = 'no error' and n = 1);

  begin
    update public.stories set locked = false where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    got := 'no error'; get diagnostics n = row_count;
  exception when others then got := sqlstate; n := -1; end;
  insert into bel213_results (step, expected, got, passed) values
    ('4b. ADMIN can unlock', 'succeeds, 1 row', got || ', ' || n::text, got = 'no error' and n = 1);

  begin
    update public.stories set published = false where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error'; get diagnostics n = row_count;
  exception when others then got := sqlstate; n := -1; end;
  insert into bel213_results (step, expected, got, passed) values
    ('4c. ADMIN can unpublish a locked story', 'succeeds, 1 row', got || ', ' || n::text, got = 'no error' and n = 1);

  begin
    update public.stories set published = true where id = 'aaaaaaaa-0000-4000-8000-000000000002';
    got := 'no error'; get diagnostics n = row_count;
  exception when others then got := sqlstate; n := -1; end;
  insert into bel213_results (step, expected, got, passed) values
    ('4d. ADMIN can republish a locked story', 'succeeds, 1 row', got || ', ' || n::text, got = 'no error' and n = 1);

  reset role;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. The result. Every step must read PASS.
--
--    If step 0 fails, the migration did not install and steps 3a to 3i fail for the wrong
--    reason. `supabase_migrations.schema_migrations` keys on the leading timestamp, so two
--    files sharing a version means the later-named one is treated as applied and skipped
--    silently. That is the failure mode this file's step 0 exists to catch.
-- ---------------------------------------------------------------------------------------------
select step, expected, got, passed from bel213_results order by step;

select count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed,
       count(*) as total
  from bel213_results;

rollback;
