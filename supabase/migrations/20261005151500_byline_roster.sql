-- ============================================================
-- byline_roster: the permitted bylines, as data
--
-- Issue:   BEL-188
-- Adds:    one table, ten seed rows. No column changes, no data moves.
--
-- Why
-- ---
-- `supabase/functions/api/index.ts` writes a story's byline from the
-- **bearer token**, not from the draft:
--
--   authenticate()    resolves `profile` from the api_keys row whose
--                     key_hash matches the token, and rejects any
--                     profile whose role is not writer/admin
--   stories create    author_id: profile.id      <-- the key owner
--   stories update    no author_id branch at all
--
-- So `author_id` is a property of the credential. Two consequences:
--
--   1. A key owned by an engineer or an editor publishes a story under
--      that person's name. The managing editor's ruling on BEL-69 (and
--      section 4 of the slot policy on BEL-72) names six people who may
--      not be a byline: Taz Loring, Idris Bello, Sam Oyelaran,
--      Tobias Nkemelu, Mara Vance, Grace Okoye. A byline asserts
--      authorship, so the API can produce a misattribution with no
--      operator involved and no way to notice before the story is live.
--   2. `stories update` has no `author_id` branch, and the function
--      exposes only `stories` and `weather`, so a wrong byline is
--      permanent. There is no way to correct one through the API.
--
-- Both halves are fixed in the function. This file is the schema that
-- function reads: the permitted bylines as data, so the ruling can be
-- changed without a deploy, and so the function can reject a name it
-- was never given.
--
-- Why a table and not a constant in the function
-- ---------------------------------------------
-- The blogs store already enforces the same ruling from a file,
-- `roster.json`, in EasySchedule/belmont-news-blogs. A second copy of
-- the permitted names inside this edge function would be a third place
-- for the ruling to live, and a function constant cannot change without
-- shipping a deploy. This table is the belt path's copy. Both are
-- seeded from the same ruling and have the same owner; divergence
-- between them is drift to watch, not a design.
--
-- Landing order
-- -------------
-- Apply this file BEFORE deploying the matching function change. The
-- function reads this table on every `stories` create and on every
-- write that sets a byline, and it fails closed when the table is
-- missing: `stories create` returns 500 and writes nothing. That is
-- deliberate. The belt path is the only API write path, so shipping
-- the function first would turn every publish into an error that no
-- row in the database explains. Schema first, then the function. No
-- frontend reads this table, so nothing else waits on it.
--
-- profile_id is nullable on purpose
-- ---------------------------------
-- `profiles.id` references `auth.users(id)`, so a byline cannot have a
-- profiles row until a human has created the auth user behind it. The
-- four reporters and the desk line do not have one yet. The roster is
-- therefore seeded by name, and the function refuses to write a byline
-- whose `profile_id` is still null, naming the exact profiles row the
-- operator has to create. It refuses rather than falling back: a null
-- `author_id` on a published story is unattributed copy, which is the
-- failure this change exists to prevent.
--
-- Run by:  someone with SQL access to the Belmont News project. No
-- agent can apply it - same constraint as BEL-32 and BEL-39.
--
-- Grants
-- ------
-- Read before the write, as always:
--   * The edge function connects with SUPABASE_SERVICE_ROLE_KEY, which
--     bypasses RLS and needs no table grant of its own.
--   * No frontend reads this table. It is editorial policy, not reader
--     data, so anon and authenticated get no access at all - narrower
--     than `profiles`, which is world-readable (BEL-31).
--   * Nothing in this file grants a write to any role, so this table
--     cannot become a write path for anything.
--
-- Verify after applying:
--   SELECT kind, byline, active, profile_id IS NOT NULL AS resolved
--     FROM byline_roster ORDER BY kind, byline;
--   -- expect 5 active rows (4 reporters, 1 desk) and 5 inactive
--
-- Safe to re-run: every statement is idempotent.

begin;

-- ============================================================
-- 1. The table
-- ============================================================
CREATE TABLE IF NOT EXISTS byline_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  byline text NOT NULL UNIQUE,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'reporter' CHECK (kind IN ('reporter', 'desk')),
  active boolean NOT NULL DEFAULT true,
  ruling text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.byline_roster IS
  'Permitted story bylines. The API function resolves a draft''s byline against this table and rejects anything not listed. Seeded from the ruling on BEL-69; authority is the managing editor.';

-- ON DELETE SET NULL, not CASCADE: deleting the auth user behind a
-- byline must leave the ruling standing and the write refused, not
-- delete the record that the name was ever permitted.

-- ============================================================
-- 2. Grants
-- ============================================================
ALTER TABLE byline_roster ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.byline_roster FROM PUBLIC;
REVOKE ALL ON TABLE public.byline_roster FROM anon, authenticated;
GRANT SELECT ON TABLE public.byline_roster TO service_role;

-- RLS is enabled with no policy for anon or authenticated, so even a
-- grant added later by hand reads zero rows. service_role bypasses RLS.

-- ============================================================
-- 3. Index
-- ============================================================
-- The function resolves one row per write. byline is already UNIQUE
-- (so indexed); this covers the desk-row lookup, which is the default
-- path for any draft that does not name its byline.
CREATE INDEX IF NOT EXISTS idx_byline_roster_desk
  ON byline_roster (kind) WHERE active;

-- ============================================================
-- 4. Seed
-- ============================================================
-- Permitted. The managing editor's ruling on BEL-69, 2026-10-05.
-- profile_id is left null on purpose - see the header. The operator
-- creates the auth user and the profiles row, then fills it in here.
INSERT INTO byline_roster (byline, kind, active, ruling) VALUES
  ('Dev Okafor',             'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
  ('Priya Raghunathan',      'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
  ('Rosa Delgado',           'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
  ('Hana Ishikawa',          'reporter', true,  'BEL-69 ruling 2026-10-05: permitted byline'),
  ('Belmont News staff',     'desk',     true,  'BEL-69 ruling 2026-10-05: desk line for items with no single reporter')
ON CONFLICT (byline) DO UPDATE
  SET kind     = excluded.kind,
      active   = excluded.active,
      ruling    = excluded.ruling,
      updated_at = now();
-- profile_id is deliberately absent from the DO UPDATE: re-running this
-- file must never clear a profile_id an operator has since filled in.

-- Not permitted, kept as inactive rows so the ruling is legible in the
-- schema and nobody re-adds a name the desk has already ruled on. An
-- inactive row is inert: the function only reads active rows.
INSERT INTO byline_roster (byline, kind, active, ruling) VALUES
  ('Taz Loring',      'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - writes code, does not file copy'),
  ('Idris Bello',     'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - publishing engineer'),
  ('Sam Oyelaran',    'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - engineer'),
  ('Tobias Nkemelu',  'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - QA'),
  ('Mara Vance',      'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline - managing editor'),
  ('Grace Okoye',     'reporter', false, 'BEL-69 ruling 2026-10-05: not permitted as a byline')
ON CONFLICT (byline) DO UPDATE
  SET kind     = excluded.kind,
      active   = excluded.active,
      ruling    = excluded.ruling,
      updated_at = now();

-- ============================================================
-- 5. Make PostgREST see it
-- ============================================================
-- The edge function reads this table over PostgREST. A table created by
-- pasting SQL into the editor is not in the schema cache until the cache
-- is reloaded, and until it is, the function gets PGRST205 "could not find
-- the table" and refuses every write. The NOTIFY is delivered on COMMIT.
-- If you apply this through the Supabase CLI, it reloads the cache itself
-- and this line does nothing.
NOTIFY pgrst, 'reload schema';

commit;
