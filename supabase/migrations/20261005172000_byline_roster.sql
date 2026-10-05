-- ============================================================
-- byline_roster: the permitted bylines, as data
--
-- Issue:   BEL-188, review findings 1-7 on PR #24
-- Adds:    one table, two functions, ten seed rows. No column changes,
--          no data moves, no change to any existing grant.
--
-- Why
-- ---
-- `supabase/functions/api/index.ts` wrote a story's byline from the
-- **bearer token**, not from the draft:
--
--   authenticate()    resolves `profile` from the api_keys row whose
--                     key_hash matches the token, and rejects any
--                     profile whose role is not writer/admin
--   stories create    author_id: profile.id      <-- the key owner
--   stories update    no author_id branch at all
--
-- And the string a reader actually sees is neither of those. It is
-- `profiles.display_name`:
--
--   StoryDetailPage.tsx:141-143   By {story.author.display_name}
--   StoryDetailPage.tsx:55-62     author = the profiles row for author_id
--
-- So the roster has to close the gap between a **permitted name** and the
-- **correct name**, or it enforces nothing. `profiles_owner_update` is a
-- table-level UPDATE policy with no column scope (base migration, lines
-- 52-56) and `DashboardPage.tsx:96` writes `display_name` from a text
-- box, so a display name can drift away from the roster entry it is
-- supposed to match - and a drifted display name renders on the story page
-- with no error anywhere. Hence `lower(profiles.display_name) =
-- lower(byline_roster.byline)` inside both functions below. It is the
-- check, not a nicety: without it a reporter can rename their profile and
-- publish under the new name while the roster reads satisfied.
--
-- Why a table and not a constant in the function
-- ---------------------------------------------
-- The blogs store also carries a byline list, `roster.json` in
-- EasySchedule/belmont-news-blogs. **The two are deliberately not
-- generated from each other, and this paragraph exists so nobody
-- automates that later.** `roster.json` holds 13 entries: five real
-- newsroom names from BEL-116, plus eight retained placeholder entries
-- that exist only so the published archive still passes its gate
-- (Margaret Vance, Grant Kowalczyk, Rosalind Kimbrough and five more).
-- Generating `byline_roster` from it would import a CEO and a placeholder
-- managing editor as permitted story bylines. They are also different
-- questions - column ownership on the archive versus story bylines - and
-- the two files even match differently (`roster.json` is exact and
-- case-sensitive, this table matches case-insensitively). Same ruling,
-- different domains. Both are owned by the CTO and both were ruled by the
-- managing editor; that is the whole relationship.
--
-- Landing order
-- -------------
-- 1. THIS FILE.
-- 2. Apply `20261005173000_stories_byline_check.sql`, which makes the two
--    RLS write policies on `stories` call `is_permitted_byline()`.
-- 3. In the Supabase **Auth dashboard** - not the SQL editor - create an
--    auth user for `Belmont News staff` and for each reporter the desk
--    wants to name. `on_auth_user_created` creates the `profiles` row
--    itself, so step 3 is a dashboard step, not SQL. Set
--    `display_name` on each to the byline exactly as spelled in the table
--    below; the functions compare them.
-- 4. SQL: set `byline_roster.profile_id` for those bylines.
-- 5. Deploy the function.
--
-- Steps 1-3 must all be done before step 5. The function fails closed, and
-- so does RLS: until a byline resolves, writes are refused. That is the
-- correct order and it is not free - a deploy at step 5 with step 3
-- missing refuses every publish with a message naming the missing row.
--
-- Grants
-- ------
-- Read before the write, as always:
--   * The edge function connects with SUPABASE_SERVICE_ROLE_KEY, which
--     bypasses RLS and needs no table grant of its own.
--   * `byline_roster` itself stays revoked from anon and authenticated.
--     Nothing reads the table over PostgREST.
--   * What authenticated callers get is two SECURITY DEFINER functions
--     that return only what a caller legitimately needs: a boolean for
--     RLS, and the permitted name/id pairs for the admin panel's byline
--     picker. Neither exposes the inactive rows or the ruling text, and
--     both refuse a caller who is not a writer or an admin, so an ordinary
--     signed-in reader cannot use either as a membership oracle.
--   * The edge function needs neither. It connects as service_role and
--     reads the table directly, so it is unaffected by the writer-only
--     guard on these two.
--   * Nothing in this file grants a write to any role.
--
-- The exposure if this ever leaks is **reads**, not writes: the ruling
-- becomes public. It is already effectively public - `roster.json` is in a
-- public repository and `profiles` is world-readable by anon (BEL-31) - so
-- this does not create a new class of exposure. The accident to watch for
-- is a blanket `GRANT ALL ON ALL TABLES IN SCHEMA public` applied later by
-- someone else, which would hand the table itself to anon. Nothing in the
-- repo does that today.
--
-- Verify after applying:
--   SELECT kind, byline, active, profile_id IS NOT NULL AS resolved
--     FROM byline_roster ORDER BY kind, byline;
--   -- expect 5 active rows (4 reporters, 1 desk) and 5 inactive
--
--   SELECT * FROM permitted_bylines();   -- run as authenticated
--
-- Safe to re-run: every statement is idempotent.

begin;

-- ============================================================
-- 1. The table
-- ============================================================
CREATE TABLE IF NOT EXISTS byline_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  byline text NOT NULL,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'reporter' CHECK (kind IN ('reporter', 'desk')),
  active boolean NOT NULL DEFAULT true,
  ruling text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.byline_roster IS
  'Permitted story bylines. Every writer - the edge function and RLS alike - resolves a byline against this table and refuses anything not listed. Seeded from the ruling on BEL-69; authority is the managing editor.';

-- ON DELETE SET NULL, not CASCADE: deleting the auth user behind a byline
-- must leave the ruling standing and the write refused, not delete the
-- record that the name was ever permitted.

-- Case-insensitive uniqueness, and it replaces a column-level UNIQUE.
-- `byline text UNIQUE` in Postgres is case-sensitive, while every lookup
-- matches case-insensitively - so `Dev Okafor` and `dev okafor` could
-- both sit here as two rows and a `find` would pick one arbitrarily.
-- One index, both behaviours.
CREATE UNIQUE INDEX IF NOT EXISTS idx_byline_roster_byline_ci
  ON byline_roster (lower(byline));

-- ============================================================
-- 2. Grants on the table
-- ============================================================
ALTER TABLE byline_roster ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.byline_roster FROM PUBLIC;
REVOKE ALL ON TABLE public.byline_roster FROM anon, authenticated;
GRANT SELECT ON TABLE public.byline_roster TO service_role;

-- RLS is enabled with no policy for anon or authenticated, so even a
-- grant added later by hand reads zero rows. service_role bypasses RLS.

-- ============================================================
-- 3. Index for the default-byline lookup
-- ============================================================
-- The function resolves one row per write. lower(byline) is already
-- indexed above; this covers the desk-row lookup, which is the default
-- path for any draft that does not name its byline.
CREATE INDEX IF NOT EXISTS idx_byline_roster_desk
  ON byline_roster (kind) WHERE active;

-- ============================================================
-- 4. Seed
-- ============================================================
-- Permitted. The managing editor's ruling on BEL-69, 2026-10-05.
-- profile_id is left null on purpose - see the landing order. The operator
-- creates the auth user, which creates the profiles row, then fills in
-- profile_id and makes display_name match `byline` here.
--
-- Written as an update-then-insert rather than ON CONFLICT on the
-- case-insensitive index, for two reasons: profile_id is never in the
-- conflict target's SET list, so re-running this file cannot clear a value
-- an operator has filled in; and the match is case-insensitive in both
-- directions, which is what the unique index above enforces.
DO $$
DECLARE
  seed_byline   text;
  seed_kind     text;
  seed_active   boolean;
  seed_ruling   text;
BEGIN
  FOR seed_byline, seed_kind, seed_active, seed_ruling IN
    SELECT * FROM (VALUES
      ('Dev Okafor',         'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
      ('Priya Raghunathan',  'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
      ('Rosa Delgado',       'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
      ('Hana Ishikawa',      'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
      ('Belmont News staff', 'desk',     true,  'BEL-69 ruling 2026-10-05: desk line for items with no single reporter'),
      -- Not permitted, kept as inactive rows so the ruling is legible in
      -- the schema and nobody re-adds a name the desk already ruled on.
      -- An inactive row is inert: nothing here reads inactive rows.
      ('Taz Loring',         'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - writes code, does not file copy'),
      ('Idris Bello',        'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - publishing engineer'),
      ('Sam Oyelaran',       'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - engineer'),
      ('Tobias Nkemelu',     'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - QA'),
      ('Mara Vance',         'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - managing editor'),
      ('Grace Okoye',        'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline')
    ) AS t(byline, kind, active, ruling)
  LOOP
    UPDATE byline_roster
       SET kind       = seed_kind,
           active     = seed_active,
           ruling     = seed_ruling,
           updated_at = now()
     WHERE lower(byline) = lower(seed_byline);

    IF NOT FOUND THEN
      INSERT INTO byline_roster (byline, kind, active, ruling)
      VALUES (seed_byline, seed_kind, seed_active, seed_ruling);
    END IF;
  END LOOP;
END
$$;

-- ============================================================
-- 5. The two things callers are allowed to ask for
-- ============================================================
-- SECURITY DEFINER, owned by the migration role, so these bypass
-- byline_roster's own RLS without anyone being granted a read on it.
-- search_path is pinned: an unpinned SECURITY DEFINER function is
-- search-path injectable.
--
-- Both are STABLE and take no writer-controlled object references.

CREATE OR REPLACE FUNCTION public.is_permitted_byline(p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    -- Callers who are not a writer or an admin get nothing back, including
    -- the service role's own calls, so this cannot be used as a membership
    -- oracle by an ordinary signed-in reader. See the audience note below.
    WHEN NOT EXISTS (
      SELECT 1 FROM profiles
       WHERE id = auth.uid() AND role IN ('writer', 'admin')
    ) THEN false
    ELSE EXISTS (
      SELECT 1
        FROM byline_roster r
        JOIN profiles p ON p.id = r.profile_id
       WHERE r.active
         AND r.profile_id = p_author_id
         AND lower(p.display_name) = lower(r.byline)
    )
  END;
$$;

COMMENT ON FUNCTION public.is_permitted_byline(uuid) IS
  'True when this profile id is a permitted byline and its display_name still matches the roster. Called from the stories RLS policies, so it has to bypass byline_roster RLS.';

-- The admin panel needs name -> id to offer a byline picker. Returning
-- pairs rather than granting SELECT on the table keeps the inactive rows
-- and the ruling text private to this function's output shape.
CREATE OR REPLACE FUNCTION public.permitted_bylines()
RETURNS TABLE (byline text, profile_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- The caller must be a writer or an admin. Without this, any signed-in
  -- reader of the app - and it has public comments, so non-writers exist -
  -- could call rpc/permitted_bylines for the permitted bylines and their
  -- profile ids, or use is_permitted_byline as a membership oracle.
  --
  -- Severity is low: profiles is already world-readable under
  -- profiles_public_read (BEL-31), so ids and display names are not secret.
  -- But `authenticated` is broader than the intent, and the panel is the
  -- only caller that needs either function. auth.uid() is null for anon and
  -- for service_role, so both get the empty answer rather than the rows.
  SELECT r.byline, r.profile_id
    FROM byline_roster r
    JOIN profiles p ON p.id = r.profile_id
   WHERE r.active
     AND lower(p.display_name) = lower(r.byline)
     AND EXISTS (
       SELECT 1 FROM profiles caller
        WHERE caller.id = auth.uid() AND caller.role IN ('writer', 'admin')
     )
   ORDER BY r.kind DESC, r.byline;
$$;

COMMENT ON FUNCTION public.permitted_bylines() IS
  'Permitted bylines with a resolved, non-drifted profiles row. Used by the admin panel byline picker; PostgREST exposes it as rpc/permitted_bylines.';

REVOKE ALL ON FUNCTION public.is_permitted_byline(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.permitted_bylines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_permitted_byline(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.permitted_bylines() TO authenticated;

-- anon does not get either: anon only reads published stories, and the
-- SELECT policy never calls a function.

-- ============================================================
-- 6. Make PostgREST see it
-- ============================================================
-- The edge function reads this table over PostgREST, and the admin panel
-- calls permitted_bylines() over it. A table created by pasting SQL into
-- the editor is not in the schema cache until the cache is reloaded, and
-- until it is, the function gets PGRST205 "could not find the table" and
-- the panel gets PGRST202 "could not find the function". The NOTIFY is
-- delivered on COMMIT. Applying through the Supabase CLI reloads the cache
-- itself and this line does nothing.
-- ============================================================
-- 6. Make PostgREST see it
-- ============================================================
-- The edge function reads this table over PostgREST, and the admin panel
-- calls permitted_bylines() over it. A table created by pasting SQL into
-- the editor is not in the schema cache until the cache is reloaded, and
-- until it is, the function gets PGRST205 "could not find the table" and
-- the panel gets PGRST202 "could not find the function". The NOTIFY is
-- delivered on COMMIT. Applying through the Supabase CLI reloads the cache
-- itself and this line does nothing.
NOTIFY pgrst, 'reload schema';

commit;