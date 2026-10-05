/*
# profiles: a signed-in reader cannot promote themselves to admin

1. Purpose
   `profiles_owner_update` is table-level and carries no column list:

       CREATE POLICY "profiles_owner_update"
         ON profiles FOR UPDATE TO authenticated
         USING (auth.uid() = id)
         WITH CHECK (auth.uid() = id);

   So a user may change ANY column of their own row, and one of those columns is `role`. As
   any signed-in user, with nothing but their own JWT:

       UPDATE profiles SET role = 'admin' WHERE id = auth.uid();

   The base schema's own header states the intent as "owner can update display_name; admin can
   update role". This file implements the part that was missing. The `role` column keeps its
   `CHECK (role IN ('user','writer','admin'))`, which bounds the value; it never bounded who
   could set it.

2. Why this is the hinge, not a footnote
   Every write policy in this schema authorises on `profiles.role IN ('writer','admin')` or
   `= 'admin'`: `stories_writer_insert`, `stories_writer_update`, `stories_admin_delete`,
   `weather_writer_insert`, `weather_writer_update`, `weather_admin_delete` (BEL-175),
   `comments_owner_or_admin_delete`. One self-promotion opens all of them at once. Closing this
   is what makes the argument in BEL-220 hold -- that RLS is the only place a future client is
   covered without anyone remembering to add a check somewhere else.

   Signup is not a second vector. `handle_new_user()` hard-codes `'user'` and ignores
   `raw_user_meta_data->>'role'`. `profiles` has no other trigger on any path: the only trigger
   on the table before this file is `on_auth_user_created`, an `AFTER INSERT` on `auth.users`.

3. Why a trigger and not a column-scoped grant
   The alternative is `GRANT UPDATE (display_name) ON profiles TO authenticated` with role
   changes moved to a service-role path. This repository has never carried column-level grants:
   across every migration the only GRANT or REVOKE is on `public.comments_public`
   (`20261005160000_comments_public_view.sql:102-103`), and
   `20261005140000_weather_forecasts_deferred_fields.sql` leaves its own grant block commented
   out on purpose. The first column-level grant on `profiles` would change what every existing
   client may write, and the check that would tell us whether that is safe has not been run --
   see section 4.

   A trigger is additive. It cannot remove a privilege, only refuse a row, so it cannot
   half-apply the way a narrowed grant can. It also survives being wrong about grants: whatever
   `authenticated` holds on `profiles`, this refuses a role change from a non-admin.

4. Grants are NOT touched, and that is deliberate -- but read this before applying
   A trigger does not change table privileges. `authenticated` keeps whatever UPDATE privilege
   it already had on `profiles`; it simply reaches fewer rows.

   Run this before applying:

       select
         (select count(*) > 0
            from information_schema.table_privileges
           where table_schema = 'public' and table_name = 'profiles'
             and grantee = 'authenticated' and privilege_type = 'UPDATE')
           as update_is_table_level,
         (select coalesce(string_agg(column_name, ', ' order by column_name), '')
            from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'profiles'
             and grantee = 'authenticated' and privilege_type = 'UPDATE')
           as update_columns;

   The expected answer is `update_is_table_level = true`. That is Supabase's default, granted
   at table level through default privileges, and it is what this migration's section 3 assumes.

   Do NOT test this by asking whether `information_schema.column_privileges` returns any rows.
   It always does. A table-level grant is reported there too, expanded one row per column, and
   the table owner appears with their implicit privileges whether or not anything was granted.
   On a Supabase project with nothing column-scoped, that view still returns rows for
   `postgres` and for `authenticated`. An empty result means something is wrong with the query,
   not that the grants are narrow. Compare `table_privileges` against `column_privileges` for
   the grantee, as above, or the check will read as a false alarm.

   If `update_is_table_level` comes back false, then `authenticated` holds UPDATE on named
   columns only, `role` may not be among them, and this trigger is layered over a base nobody
   expected. Stop, and re-read the finding before running anything. A trigger refuses a row; it
   cannot grant the privilege back, so a narrow grant that omits `role` needs its own migration
   rather than a retry of this one.

   `service_role` is unaffected by this file either way; it bypasses RLS, which is what keeps
   the admin path in section 6 working.

5. What the trigger allows, and what it refuses
   Refused: any authenticated, non-admin caller changing `role` on any row. The error names the
   admin path, so the person who hits it is told what to do next instead of just that it failed.

   Allowed, and each of these is a path the newsroom already depends on:
     - a change that does not touch `role` at all. The trigger is `BEFORE UPDATE OF role`, so a
       writer or a plain reader editing their own `display_name` (`DashboardPage.tsx:96`) never
       reaches it;
     - a change that sets `role` to the value it already has. A no-op is not an escalation;
     - the service_role path: the Supabase SQL editor, `psql`, the CLI, or any edge function
       built with SUPABASE_SERVICE_ROLE_KEY (`supabase/functions/api/index.ts:10`);
     - an existing admin, on their own row. That behaviour is unchanged.

   `auth.uid() IS NULL` is the SQL editor, `psql` and the CLI: a session with no JWT on it at
   all, which no browser request can reach, because PostgREST sets the claims from a verified
   token or returns 401 before the database is involved. Without that branch the Supabase SQL
   editor -- how every migration in this repository is applied, and how a wrong role would be
   corrected -- would be the one place the guard refused to work.

6. What is NOT fixed here, on purpose
   The admin UI's role dropdown (`DashboardPage.tsx:819-825`) writes
   `.update({ role: newRole }).eq('id', userId)` against another user's row using the reader's
   own JWT. `profiles_owner_update` admits only `auth.uid() = id`, so RLS filters the row out
   before the statement reaches a row. PostgREST returns success with zero rows, `error` is
   null, and the panel reloads with the dropdown snapped back. That dropdown is already a silent
   no-op on `main`, with or without this migration -- RLS hides the row, so the trigger is never
   invoked and there is no behaviour change. It is reported as a separate finding rather than
   fixed here, because making it work means granting admins table-level UPDATE on `profiles`,
   which would let them rewrite every other user's `email`, `id` and `created_at` as well. That
   is a new privilege and it needs the section 4 read first.

   Role changes today are made with the service_role key. That is the documented path:

       -- Supabase SQL editor, or psql against the project
       update profiles set role = 'writer' where id = '<user uuid>';

7. Reads are untouched
   `profiles_public_read` is not in this file. It is `TO anon, authenticated USING (true)` and
   stays exactly as it is, so the public byline (`StoryDetailPage.tsx:58`) and every anon read
   of `profiles` keep working. This file adds a trigger and changes no policy and no grant.

8. Ordering
   Database only. Merge applies nothing; applying this file is a separate step. There is no
   frontend in this change and nothing to deploy to Bolt after it. Apply it on its own,
   whenever the next schema apply happens -- it narrows an existing hole and adds no column,
   so it creates no PostgREST schema-cache dependency either way.

9. How this was verified
   Against a real PostgreSQL 18 given the shape of a Supabase project: the `auth` schema with
   Supabase's own `auth.uid()` and `auth.role()` definitions, `auth.users`, the `anon`,
   `authenticated` and `service_role` roles with `service_role` carrying BYPASSRLS, and
   table-level privileges granted through default privileges the way Supabase does it. Each
   request was run as a request: JWT claims set from a token, then `SET LOCAL ROLE`.

   Both states were run, and the difference is the finding:

     - base schema alone, no fix: `UPDATE profiles SET role = 'admin' WHERE id = auth.uid()`
       succeeds as a plain reader, and the same reader then deletes a published story. The
       escalation is not theoretical; it reaches `stories` in one step.
     - base schema plus this file: that statement is refused with 42501, the reader's role is
       identical before and after, and 20 further assertions hold -- the no-op `SET role = role`,
       writer and reader `display_name` edits, an admin changing their own role, `service_role`
       changing any role, a no-JWT session changing any role, anon reads of `profiles` and the
       byline join, and both `profiles` policies unchanged.

   Section 4's grant query came out of that run. The first version asked whether
   `information_schema.column_privileges` returned rows and expected none. On a table-level
   grant it returns rows anyway, so that check would have read as a false alarm on a project
   whose grants are wide open. It now compares the two views for the grantee that matters.

   Not verified, because no agent holds a SQL route to the project: the migration has not been
   applied to Supabase, and no statement in section 4 has been run against the real database.
*/

-- ============================================================
-- TRIGGER: a non-admin may not change profiles.role
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_profiles_role_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- auth.role() is Supabase's own accessor: it coalesces the legacy
  -- request.jwt.claim.role GUC with the modern request.jwt.claims JSON, and returns NULL
  -- when the session carries no JWT at all (the SQL editor, psql, the CLI).
  caller_role text := auth.role();
BEGIN
  -- Not an escalation. Lets a caller that names `role` in its SET list but writes the value
  -- it already holds proceed untouched.
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  -- Server-side admin paths: a session with no JWT, or the service_role key.
  IF caller_role IS NULL OR caller_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- An existing admin, on their own row. Unchanged behaviour from profiles_owner_update.
  IF EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = auth.uid()
       AND p.role = 'admin'
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'profiles.role cannot be changed by this caller. Changing a role requires the service_role key (Supabase SQL editor, psql, the CLI, or an edge function using SUPABASE_SERVICE_ROLE_KEY), or an existing admin. Ask an admin to make this change.'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_role_update ON public.profiles;

CREATE TRIGGER profiles_guard_role_update
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_role_update();

-- ============================================================
-- VERIFY AFTER APPLYING
-- ============================================================
-- 1. The trigger is on the table, UPDATE OF role, BEFORE, per row.
--
--      select tgname, pg_get_triggerdef(oid)
--        from pg_trigger
--       where tgrelid = 'public.profiles'::regclass
--         and not tgisinternal;
--
--    Expect one new row: profiles_guard_role_update, BEFORE UPDATE OF role ON public.profiles.
--
-- 2. A plain reader's role is unchanged, and the escalation is refused. Note that the refused
--    statement aborts its transaction, so "before" and "after" cannot be read in the same one.
--    Read the role first, run the escalation, then read the role again in a fresh transaction:
--
--      begin;
--      select role as role_before from profiles where id = auth.uid();
--      rollback;
--
--      begin;
--      update profiles set role = 'admin' where id = auth.uid();
--      -- expected: ERROR  42501  profiles.role cannot be changed by this caller.
--      rollback;
--
--      begin;
--      select role as role_after from profiles where id = auth.uid();
--      rollback;
--
--    role_before and role_after must be identical. That the transaction aborts is itself part
--    of the answer: PostgREST rejects the whole write rather than silently dropping the column.
--
--    Also run the control, which must SUCCEED and change nothing:
--
--      update profiles set role = role where id = auth.uid();
--
-- 3. A writer can still edit their own display_name (DashboardPage.tsx:96):
--
--      update profiles set display_name = 'Renamed By Writer' where id = auth.uid();
--
-- 4. The service-role path still works, from the SQL editor or psql, no JWT on the session:
--
--      update profiles set role = 'writer' where id = '<user uuid>';
--      select role from profiles where id = '<user uuid>';
--
-- 5. Reads did not regress, and the policies are still exactly the two the base schema made:
--
--      select policyname, cmd from pg_policies
--       where schemaname = 'public' and tablename = 'profiles' order by 1;
--
--    Expect profiles_owner_update (UPDATE) and profiles_public_read (SELECT), and nothing else.
--    Then confirm the anon byline still reads:
--
--      curl -s "$SUPABASE_URL/rest/v1/profiles?select=id,display_name&limit=1"