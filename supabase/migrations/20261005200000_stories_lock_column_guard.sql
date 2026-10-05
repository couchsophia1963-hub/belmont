/*
# A locked story's protected state can only be changed by an admin, in the database

1. The gap this closes
   `20261005123424_20261005180000_story_locking.sql` added stories.locked and tightened
   stories_admin_delete so a locked row cannot be deleted. It could not stop a non-admin
   from clearing the lock, because it has no mechanism to. RLS is row-level:
   stories_writer_update admits every row to a writer, so a writer satisfies USING for
   every column of that row, including locked. There is no column-scoped USING in
   Postgres, so no policy rewrite can express "writers may edit this row except this
   column".

   Two shipped surfaces reach `stories` as `authenticated`, where RLS is the only gate:

   - src/pages/StoryManagerPage.tsx:210-224 (toggleLock) — writes `locked` with no
     client-side role check.
   - src/pages/StoryManagerPage.tsx:181-194 (togglePublished) — writes `published` with
     no lock check.

   Both therefore answered "who may change this" differently from the edge function, which
   refuses a non-admin lock/unlock and refuses to unpublish a locked story
   (supabase/functions/api/index.ts:199-209, 233-262). The function was right. The two
   paths that nothing audits were the ones deciding.

   Live effect before this migration: a writer can set locked = true or locked = false on
   any story, and a writer can take a locked story off the site by setting
   published = false. Neither is visible to an admin except as a story that is suddenly
   gone from the front page.

2. Mechanism chosen: a BEFORE UPDATE trigger. Why, and not the alternatives
   The alternatives were a column-scoped GRANT or a SECURITY DEFINER RPC for the toggle.

   - Column-scoped grants do not work here. `REVOKE UPDATE ON stories` followed by
     `GRANT UPDATE (title, body, ...) TO authenticated` would be a column-scoped
     privilege list that has to be re-edited every time a column is added, and a
     migration that adds a column while forgetting the list silently breaks writers.
     A guard that watches two named columns does not have that failure mode.
   - A SECURITY DEFINER RPC is the right shape for an audit trail, not for closing a
     hole. It would also need the client to stop writing locked directly, which means a
     frontend deploy has to land in lockstep with this migration. That is exactly the
     ordering hazard rule 2 exists to prevent: the frontend goes out saying "lock is
     admin-only", the database does not yet say it, and the window is a writer.

   The trigger is a pure database rule. It holds on every path — PostgREST, the edge
   function, psql, a future client, a script — with no dependency on a deploy having
   happened. That is the deciding factor: the frontend changes in this stack are
   presentation only, and the enforcement cannot depend on them.

   The trigger covers two things, both the same invariant:

   (a) locked and locked_until may only be changed by an admin. This is the reported gap.

   (b) a locked story may not be taken offline by a non-admin, that is, a non-admin may
       not move published from true to false while locked = true.

   (b) is beyond the literal ask. It is here because the lock is only worth its name if a
   writer cannot get the story off the site by another route, and togglePublished is a
   shipped button with no check. An admin is still free to unpublish a locked story: the
   rule refuses a non-admin, not the transition.

3. Why the trigger cannot be a RLS policy, restated as a test
   If this were a policy, the equivalent of the guard would be
   `WITH CHECK (admin or locked unchanged)`. Postgres gives no access to OLD in a policy
   expression, so there is nothing to compare "unchanged" against. A trigger is the only
   place OLD and NEW are both in scope. That is the whole reason this is a trigger.

4. Who the trigger refuses, precisely
   It refuses when auth.uid() IS NOT NULL AND the caller's profiles.role is not 'admin'.

   - PostgREST as `authenticated`: auth.uid() is set, so a writer is refused. This is the
     path the gap was reported on and the only path this migration is about.
   - service_role: auth.uid() is NULL, so the trigger passes it through. The edge
     function authorises lock and unlock itself, by role, before writing
     (supabase/functions/api/index.ts:236, 253). Residual trust: a holder of the
     service_role key can still change locked. That is the same trust boundary the
     function already sits on and widening it is not in scope here. If the service_role
     key ever leaks, this trigger does not stop it; rotation does.
   - psql or the SQL editor as an operator: auth.uid() is NULL, so a manual repair works.
     Deliberate. If the trigger also refused here, the only way to clear a bad lock
     would be to drop the trigger.
   - anon: has no UPDATE privilege on stories, so it never reaches this trigger. auth.uid()
     is NULL here too, which is why auth.uid() NULL is not by itself evidence of an
     admin.

   What this trigger does NOT cover, stated so no one over-reads it:

   - INSERT. This is a BEFORE UPDATE trigger. `stories_writer_insert` has a WITH CHECK on
     the caller's role only, and a WITH CHECK has no OLD to compare against and no
     column-scoped form, so a writer can still INSERT a row born with locked = true.
     Because `stories_admin_delete` requires locked = false, such a row cannot be deleted
     by anyone, including an admin, until an admin unlocks it. That is a nuisance and a
     cleanup chore, not an escalation: it cannot lock or unpublish anyone else's story,
     which is what BEL-213 reported. Closing it needs a BEFORE INSERT trigger, which is
     a separate change and not in this file.
   - A writer may still take an UNLOCKED story offline, and may publish a locked story.
     Rule (b) guards only the locked-and-published to unpublished direction.

5. Grants: read before applying, and this file changes none
   Rule 3 applies. Run this first:

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
           as columns_with_explicit_acl;

   Expected: `update_is_table_level = true` and `columns_with_explicit_acl = 0`, with
   `update_columns` listing every column including `locked` and `locked_until`. That is
   Supabase's default, granted at table level through default privileges, and a
   table-level privilege covers columns added later by ALTER TABLE. locked and
   locked_until are already inside the grant authenticated holds. No new grant is
   required and none is issued here.

   Do NOT test this by asking whether `information_schema.column_privileges` returns any
   rows. It always does. Its first UNION branch explodes the *table* ACL and pairs it
   with every column, so a table-level grant is reported once per column, and the table
   owner appears with its implicit privileges whether or not anything was ever granted.
   An earlier revision of this comment used that query and told the reader that any row
   meant STOP. Measured against a real PostgreSQL engine, it returns 16 rows for
   `stories` on a database with nothing column-scoped, so it reported STOP on the one
   environment this file is correct for. `columns_with_explicit_acl` is the actual
   detector: `attacl` is NULL unless a column carries its own ACL.

   If `update_is_table_level` comes back false, then `authenticated` holds UPDATE on
   named columns only. If `locked` is not in `update_columns`, every writer edit to this
   table fails after this trigger installs. Stop and extend the grant in this same
   change. A trigger refuses a row; it cannot grant the privilege back.

   anon is never granted anything on stories in this file. The trigger narrows which rows
   a role may change. It must not widen any privilege.

6. Reversibility
   The trigger is dropped and recreated rather than replaced in place, matching the
   handle_new_user pattern in 20261004123918_create_belmont_news_schema.sql. Each
   migration file runs in one transaction under supabase db push, so a failure part way
   through leaves no trigger behind. To undo by hand:

       drop trigger if exists stories_guard_lock_columns on public.stories;
       drop function if exists public.stories_guard_lock_columns();

   Rollback reopens the gap described in section 1. Say so in the change log.

7. Ordering
   Database first. Apply 20261005123424_20261005180000_story_locking.sql, then this file,
   then any frontend. The guard references stories.locked, so it must come after the
   column exists; the reverse order fails and rolls back cleanly.

   This file's version is 20261005200000, not 20261005190000. It was first written as
   20261005190000 and renamed during review of BEL-217, because
   20261005190000_profiles_role_not_self_assignable.sql (BEL-224) already holds that
   version on main. Supabase keys the migration ledger on the leading timestamp, not the
   filename, so two files sharing a version collide in supabase_migrations
   .schema_migrations. The later-named of the pair is then treated as already applied
   and `supabase db push` skips it silently. That is the exact failure this newsroom
   cannot have: a trigger that never installs while the ledger says it did. The rename
   is safe because this file has never been applied anywhere — see section 8.

   Security dependency, and it is a real one. This trigger decides admin-ness from
   profiles.role. If BEL-224's profiles trigger is not applied, a writer can first run
   `update profiles set role = 'admin' where id = auth.uid()` and then pass this guard
   freely, so the guard would be sound in form and worthless in effect. Applying
   20261005190000_profiles_role_not_self_assignable.sql first is therefore required for
   this trigger to mean anything, not merely preferred. Migration order gives it for
   free, because that version sorts first. Do not cherry-pick this file alone.

   There is no function deploy in this change. The edge function is unchanged: it already
   refused a non-admin lock and unlock, and it keeps working because service_role passes
   this trigger. Nothing about this migration requires `supabase functions deploy api`.

   Merge redeploys nothing. Applying these two files is a separate, currently blocked
   step — see section 8.

8. Not applied to the project database; verified against a real engine
   This file has never been applied, because no SQL route to the project database is
   available to any agent on this beat: no service_role key, no Management API token,
   no reachable Postgres port, and the secret store returns an empty list. Section 5's
   check has not been run against the real database.

   What has been done instead, on BEL-213: the whole migration chain was applied in
   version order to a real PostgreSQL engine (PGlite, Postgres 17 compiled to WASM)
   with the Supabase default table grants reproduced and `auth.uid()` /
   `auth.role()` stood in for the JWT claim GUCs. 24 assertions pass, covering both
   refusals, writers still being able to edit, all four admin paths, anon matching zero
   rows, and service_role passing through as documented. The counterfactual was run too:
   with this trigger dropped, the writer's unlock succeeds and the row really changes,
   so the suite is known to be capable of failing.

   Two limits, stated so nobody over-reads that:

   - That is engine behaviour on a fixture with emulated grants. It is not the state of
     the Belmont News database. `information_schema.column_privileges` returns 16 rows
     there for `stories` purely because the table-level grants are reproduced
     faithfully, which is what exposed the false STOP this file used to carry.
   - `attacl` on `pg_attribute` was used as the column-scope detector because it is
     NULL unless a column carries its own ACL. It was checked in both directions:
     NULL on every column with table-level grants only, and two rows named the moment
     `UPDATE` was revoked and re-granted per column.

   Whoever has SQL access still runs the queries at the bottom of this file, in order,
   before and after. This section records what has and has not been observed.
*/

CREATE OR REPLACE FUNCTION public.stories_guard_lock_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_is_admin boolean;
BEGIN
  -- Security definer with search_path pinned: the lookup below must not resolve through
  -- a caller-controlled schema, and it must not depend on profiles RLS being readable.
  caller_is_admin := EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE profiles.id = auth.uid()
       AND profiles.role = 'admin'
  );

  -- (a) Only an admin may change the lock itself. See section 3 for why this is a
  --     trigger and not a WITH CHECK clause.
  IF (NEW.locked IS DISTINCT FROM OLD.locked
      OR NEW.locked_until IS DISTINCT FROM OLD.locked_until)
     AND auth.uid() IS NOT NULL
     AND NOT caller_is_admin THEN
    RAISE EXCEPTION 'Only an admin can lock or unlock a story (story %)', OLD.id
      USING ERRCODE = '42501',
            HINT = 'Writers can edit story content. Ask an admin to change the lock.';
  END IF;

  -- (b) A non-admin may not take a locked story offline. Admins still can; the rule
  --     refuses the caller, not the transition.
  IF NEW.published IS DISTINCT FROM OLD.published
     AND OLD.published = true
     AND NEW.published = false
     AND OLD.locked = true
     AND auth.uid() IS NOT NULL
     AND NOT caller_is_admin THEN
    RAISE EXCEPTION 'This story is locked and only an admin can unpublish it (story %)', OLD.id
      USING ERRCODE = '42501',
            HINT = 'Ask an admin to unpublish this story, or unlock it first.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stories_guard_lock_columns ON public.stories;

CREATE TRIGGER stories_guard_lock_columns
  BEFORE UPDATE ON public.stories
  FOR EACH ROW
  EXECUTE FUNCTION public.stories_guard_lock_columns();

-- ---------------------------------------------------------------------------
-- Verification. Run in order. Do not apply anything above without running the first
-- two queries first; that is rule 3.
-- ---------------------------------------------------------------------------

-- 1. Before applying: confirm stories is not column-scoped. Expect
--    update_is_table_level = true and columns_with_explicit_acl = 0.
--
--    select
--      (select count(*) > 0
--         from information_schema.table_privileges
--        where table_schema = 'public' and table_name = 'stories'
--          and grantee = 'authenticated' and privilege_type = 'UPDATE')
--        as update_is_table_level,
--      (select coalesce(string_agg(column_name, ', ' order by column_name), '(none)')
--         from information_schema.column_privileges
--        where table_schema = 'public' and table_name = 'stories'
--          and grantee = 'authenticated' and privilege_type = 'UPDATE')
--        as update_columns,
--      (select count(*)
--         from pg_attribute
--        where attrelid = 'public.stories'::regclass
--          and attnum > 0 and not attisdropped and attacl is not null)
--        as columns_with_explicit_acl;
--
--    `update_is_table_level = false` means STOP, and `locked` must appear in
--    `update_columns` even when it is true. See section 5. Do not use
--    `column_privileges` row count as this test: it reports table-level grants too,
--    expanded one row per column.

-- 2. Before applying: confirm the guard does not exist yet. Expect NO ROWS.
--
--    select tgname
--      from pg_trigger
--     where tgrelid = 'public.stories'::regclass
--       and not tgisinternal;

-- 3. After applying: confirm the trigger exists. Expect exactly one row,
--    stories_guard_lock_columns.
--
--    select tgname, tgenabled, pg_get_triggerdef(oid)
--      from pg_trigger
--     where tgrelid = 'public.stories'::regclass
--       and not tgisinternal;

-- 4. After applying: confirm no policy was changed by this file. Expect the same rows
--    as before, and no writer DELETE path. This migration touches no policy.
--
--    select policyname, cmd, roles::text, qual
--      from pg_policies
--     where schemaname = 'public'
--       and tablename = 'stories'
--     order by cmd, policyname;

-- 5. The test that matters. As a WRITER, these two must fail. Do not skip it: a trigger
--    that exists and does not fire is worse than no trigger, because it reads as a fix.
--
--    -- must fail: "Only an admin can lock or unlock a story"
--    update stories set locked = true where id = '<a story id>';
--
--    -- must fail on a locked story: "only an admin can unpublish it"
--    update stories set published = false where id = '<a locked story id>';
--
--    -- must SUCCEED: this is the point of the guard, writers can still edit
--    update stories set title = title where id = '<a story id>';
--
-- 6. As an ADMIN, these must succeed, or the guard is too broad and has broken the
--    Story Manager for the people who are supposed to use it.
--
--    update stories set locked = true  where id = '<a story id>';
--    update stories set locked = false where id = '<that same id>';
--    update stories set published = false where id = '<a locked story id>';
--    update stories set published = true  where id = '<that same id>';
--
--    Then leave the row exactly as it was found. Note what it was first.
--
-- 7. The front page must still read. This trigger does not affect SELECT and
--    stories_public_read is untouched:
--
--    curl -s "$SUPABASE_URL/rest/v1/stories?select=slug,title,locked&published=eq.true&limit=3"
