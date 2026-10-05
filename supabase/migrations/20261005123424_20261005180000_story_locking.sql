/*
# Add story locking for admins

Renamed from `20261005123424_20261005180000_story_locking.sql.sql`. The extension was
doubled, which is not a legal migration filename. `supabase db push` and
`supabase migration list` key off the leading timestamp, so the version was always
20261005123424 and this rename is version-neutral: an environment that already applied
the file under the old name still records 20261005123424, and `db push` will not try to
apply it a second time. That is deliberate. Editing an applied migration in place is
how two environments end up with different schemas under the same name.

Content changes against the original, all of them corrections to the security reasoning
rather than changes to the shipped behaviour:

1. Purpose (unchanged)
   Admins can lock a story to prevent it from being deleted by anyone, including other
   admins. A locked story shows a badge in the Story Manager and the delete button is
   disabled. Locking is admin-only: writers can edit story content but must not be able
   to lock or unlock a story.

   This also lays the groundwork for "until X" time-based locks by storing an optional
   locked_until timestamp.

2. New Columns (unchanged)
   - stories.locked (boolean, NOT NULL, default false) — when true, the story cannot be
     deleted via the Story Manager or the API.
   - stories.locked_until (timestamptz, nullable) — reserved for future time-based locks.
     Stored now so a future migration can add the logic without another schema change.

3. Security — what this file does NOT do, and why that is honest
   This file adds the columns and tightens the DELETE policy. It does not stop a writer
   from setting locked. It cannot: Postgres RLS is row-level, and `stories_writer_update`
   admits every row to a writer, so the writer satisfies USING for every column of that
   row, including locked. There is no column-scoped variant of USING.

   The original comment here claimed the gap was covered. It is not. A writer reaches
   `update stories set locked = false` directly, because `StoryManagerPage.toggleLock`
   (`src/pages/StoryManagerPage.tsx:210-224`) calls PostgREST as `authenticated` with no
   client-side role check, and RLS is the only gate on that path. The edge function
   refuses a non-admin lock/unlock (`supabase/functions/api/index.ts:233-262`), so the two
   paths disagreed and the one that decided was the one nothing read.

   Enforcing admin-only on locked is therefore a separate migration with a separate
   name, so it is separately reviewable and separately applied:
   `20261005200000_stories_lock_column_guard.sql`. Do not read this file as the fix.

4. The DELETE policy and reversibility
   Postgres has no `CREATE OR REPLACE POLICY`, so DROP then CREATE is the only way to
   change one. It is safe here for two reasons, and both matter:

   - `supabase db push` applies each migration file inside a single transaction. If the
     CREATE below fails, the DROP rolls back with it and `stories_admin_delete` survives.
     There is no window in which the policy is missing.
   - The explicit rollback at the bottom of this file restores the previous policy by
     hand if it is ever needed.

   The original file had neither guarantee documented, and an operator reading it had no
   way to know that a failed CREATE could not leave every story undeletable.

5. Grants are NOT touched, and that is deliberate
   Across every migration in this repository the only GRANT or REVOKE is on
   `public.comments_public` (`20261005160000_comments_public_view.sql:102-103`). No
   migration grants anything on `stories`, so `authenticated` holds the Supabase
   table-level defaults there.

   Postgres table-level privileges cover the whole table, including columns added later
   by ALTER TABLE. `locked` and `locked_until` are therefore already covered by whatever
   UPDATE privilege `authenticated` has; they do not need a new grant, and this file must
   not issue one. Issuing one would widen the grant on the assumption that a new column
   needs extending. Read it instead, before applying:

       select t.name,
              (select count(*) from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = t.name)              as total_columns,
              (select count(distinct p.column_name) from information_schema.column_privileges p
                where p.table_schema = 'public' and p.table_name = t.name
                  and p.grantee = 'authenticated' and p.privilege_type = 'UPDATE')      as updatable_columns
         from (values ('profiles'), ('stories'), ('weather_forecasts')) as t(name);

   Expected: `updatable_columns = total_columns` on all three rows, which is the
   table-level default.

   Do NOT test this by asking whether `information_schema.column_privileges` returns any
   rows. It always does. A table-level grant is reported there too, expanded one row per
   column, and the table owner appears with their implicit privileges whether or not
   anything was granted. An empty result means something is wrong with the query, not that
   the grants are narrow.

   This section used to say the opposite -- "reports column-level grants only, so a row here
   is positive proof", with `NO ROWS` as the expected answer. That was wrong, and it is the
   defect BEL-329 records: on a project whose grants are wide open -- which is Belmont News
   -- it reads as a false STOP, and read the other way it is false reassurance, because a
   reader concludes the grants ARE narrow and applies on top of a base nobody checked.
   `20261005190000_profiles_role_not_self_assignable.sql` section 4 already carried this
   correction, learned against a real PostgreSQL 18, and every file in the BEL-48 apply now
   points at one check.

   If `updatable_columns` comes back lower than `total_columns` on any row, then
   `authenticated` does not hold UPDATE across the whole table, and a column-scoped grant on
   `stories` has to be extended to include `locked` and `locked_until` in the same change,
   or every writer update fails afterwards. Stop, and escalate with the query output. Do not
   widen a grant to make this migration pass, and do not edit this file to add a `GRANT`.

   `service_role` is unaffected. It bypasses RLS, which is what lets the edge function
   keep working while its own in-code admin check does the authorising.

6. Ordering
   Database only. This file changes the schema and one DELETE policy, so it must be
   applied before any frontend that reads or writes locked, and it must be applied
   before the guard migration lands so the columns exist when the guard attaches.
   There is no function deploy in this change and there is no frontend deploy in this
   change. The frontend that depends on this ships separately, after this is applied.
*/

ALTER TABLE stories ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- A locked story cannot be deleted through RLS by anyone, including an admin. To delete
-- it, an admin must first unlock it.
DROP POLICY IF EXISTS "stories_admin_delete" ON stories;

CREATE POLICY "stories_admin_delete"
  ON stories FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
    AND locked = false
  );

-- Rollback, by hand, only if this file must be undone on its own:
--
--   drop policy if exists "stories_admin_delete" on public.stories;
--   create policy "stories_admin_delete"
--     on public.stories for delete to authenticated
--     using (exists (
--       select 1 from public.profiles
--        where profiles.id = auth.uid() and profiles.role = 'admin'
--     ));
--
-- Verify after applying. Expect exactly one DELETE policy on stories, and a qual that
-- names locked:
--
--   select policyname, cmd, roles::text, qual
--     from pg_policies
--    where schemaname = 'public'
--      and tablename = 'stories'
--      and cmd = 'DELETE';
--
-- Confirm the two new columns exist and are NOT NULL with a false default:
--
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'stories'
--      and column_name in ('locked', 'locked_until')
--    order by column_name;
--
-- Do NOT run this file as an UPDATE test. It does not make a writer's update to locked
-- fail; see section 3 and apply the guard migration for that.
