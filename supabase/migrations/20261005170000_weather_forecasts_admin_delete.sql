/*
# weather_forecasts: deleting a forecast is admin-only, in RLS as well as in the API

1. Purpose
   The API function now refuses a non-admin weather delete
   (`supabase/functions/api/index.ts:337-342`, landed in #9). RLS still says otherwise:
   `weather_writer_delete` admitted `writer` and `admin`. That left the newsroom with two
   different answers to "who may delete a forecast", and the answer that decided it was the
   one nothing read.

   This change makes the policy match the rule the API enforces. Admin only, both paths.

2. Why the function needed the code check as well, and why this needed the policy
   The function's client is built with SUPABASE_SERVICE_ROLE_KEY (`index.ts:10,12`), so RLS
   never applies on that path. That is why the guard had to be added in the function rather
   than read off an existing policy.

   The reverse is also true and is why this file exists: `DashboardPage` and the browser
   reach `weather_forecasts` through PostgREST as `authenticated`, where RLS is the only gate.
   Narrowing the function alone would have narrowed half the system.

3. The policy is renamed, not just narrowed
   `weather_writer_delete` -> `weather_admin_delete`, matching the existing
   `stories_admin_delete`. The old name would have been a lie after this change: a policy
   called "writer_delete" that no writer may use is worse than no name at all. Nothing
   references the old name outside the migration files, so the rename costs one DROP.

4. Grants are NOT touched, and that is deliberate
   A DROP/CREATE POLICY changes which rows a role may act on. It does not change table
   privileges. `authenticated` keeps whatever DELETE privilege it already had; it simply
   matches fewer rows.

   Read before applying, per the standing rule about column-scoped grants. Across every
   migration in this repository the only GRANT or REVOKE is on `public.comments_public`
   (`20261005160000_comments_public_view.sql:102-103`). There is no GRANT on
   `weather_forecasts` anywhere, so its privileges are the Supabase table-level defaults and
   this migration cannot half-apply through a missing grant.

   If that check ever comes back with a column-scoped grant, stop and do not run this
   blind -- a column-scoped grant would need extending in this same change:

       select
         (select count(*) > 0
            from information_schema.table_privileges
           where table_schema = 'public' and table_name = 'weather_forecasts'
             and grantee = 'authenticated' and privilege_type = 'DELETE')
           as delete_is_table_level,
         (select count(*)
            from pg_attribute
           where attrelid = 'public.weather_forecasts'::regclass
             and attnum > 0 and not attisdropped and attacl is not null)
           as columns_with_explicit_acl;

   `delete_is_table_level = true` is the Supabase default and the expected answer.

   Do not judge this by counting rows in `information_schema.column_privileges`. A
   table-level grant is reported there too, expanded to one row per column, and the
   table owner appears with implicit privileges regardless, so that view returns rows
   on a database with nothing column-scoped. An earlier revision of this comment used
   it and told the reader that rows meant stop. Note also that DELETE cannot be granted
   per column in Postgres, so `column_privileges` cannot even report it; the honest test
   is `delete_is_table_level`. `columns_with_explicit_acl` catches the write and read
   grants this table does carry.

   `service_role` is unaffected. It bypasses RLS, which is what lets the function keep
   working once its in-code guard does the authorising.

5. Who this removes, and why that is safe today
   A writer loses the ability to delete a forecast through PostgREST.

   No shipped surface depends on it. `DashboardPage.tsx` reads `weather_forecasts` at :503
   and writes at :563, both selects and upserts; it never deletes. The only weather delete in
   the admin UI is the `curl` example at :391-395, which is text inside a `<pre>`
   documentation block for a human to copy, not a button. `StoryManagerPage` does not touch
   this table.

   So a reporter who loses this loses an ability they could only reach by hand-writing a
   PostgREST DELETE, not a workflow. That is the whole basis for calling this safe, and it
   is worth re-reading if a weather delete button is ever added to the panel: at that point
   the policy and the UI have to be re-decided together.

6. Ordering
   Database first, then `supabase functions deploy api`. This migration must be applied
   before the function carrying the #9 guard is deployed, so that neither path is the only
   one enforcing the rule at any moment.

   Merge redeploys nothing. Applying this file is a separate step, and so is the deploy.

7. Safe to re-run
   Both DROPs are `IF EXISTS` and the CREATE is preceded by a drop of the same name, which
   is the pattern every other policy in this directory already follows. That last part was
   missing: this file originally dropped only the old `weather_writer_delete` and then
   created `weather_admin_delete`, so a second run failed with 42710 duplicate_policy and
   a replay from the top could never finish. It matters because the migrations here were
   largely applied by hand through the dashboard, so the first `db push` is a replay and
   this file was the one that would have stopped it.
*/

DROP POLICY IF EXISTS "weather_writer_delete" ON public.weather_forecasts;
DROP POLICY IF EXISTS "weather_admin_delete" ON public.weather_forecasts;

CREATE POLICY "weather_admin_delete"
  ON public.weather_forecasts FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- Verify after applying. Expect exactly one policy for DELETE, and no writer path to it.
--
--   select policyname, cmd, roles::text, qual
--     from pg_policies
--    where schemaname = 'public'
--      and tablename = 'weather_forecasts'
--      and cmd = 'DELETE';
--
-- Expect one row: weather_admin_delete, DELETE, {authenticated}, and a qual that names
-- role = 'admin' rather than role IN ('writer', 'admin').
--
-- Confirm the homepage strip still reads. `weather_public_read` is untouched by this file,
-- and it is the policy that serves the front page:
--
--   curl -s "$SUPABASE_URL/rest/v1/weather_forecasts?select=forecast_date,condition&limit=1"