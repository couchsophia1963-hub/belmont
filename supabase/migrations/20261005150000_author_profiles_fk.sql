-- ============================================================
-- stories.author_id / comments.user_id -> public.profiles(id)
--
-- Issues:  BEL-38 (story byline embed 400s), BEL-34 (comment embed 400s)
-- Adds:    nothing. Two foreign keys that were never declared.
--
-- Why this is needed
-- ------------------
-- The base migration declares:
--   stories.author_id  uuid REFERENCES auth.users(id)          ON DELETE SET NULL
--   comments.user_id   uuid REFERENCES auth.users(id)          ON DELETE CASCADE
--
-- Both columns therefore do have a foreign key, and PostgREST's error message
-- is misleading about it: `stories_author_id_fkey` exists. The problem is that
-- it targets `auth.users`, and PostgREST only resolves relationships whose target
-- table is inside the exposed `public` schema. The `auth` schema is not exposed
-- through the REST API, so the key cannot be used to bridge to `profiles`.
--
-- There is no `stories` -> `profiles` relationship in the schema cache, so the
-- byline embed fails to parse and the whole query 400s before reading a row:
--
--   GET /rest/v1/stories
--       ?select=*,author:profiles!stories_author_id_fkey(display_name)
--   -> 400 PGRST200 "Could not find a relationship between 'stories' and
--       'profiles' in the schema cache"
--
-- Every /story/:slug page took the queryError branch and rendered
-- "Failed to load story". Dropping the hint does not help; PostgREST reports the
-- same PGRST200 with no hint at all.
--
-- Both `stories.author_id` and `profiles.id` are `auth.users(id)`, so the join
-- is valid. Declaring it here is what lets a single-query embed work again.
--
-- ON DELETE actions deliberately match the existing auth.users keys, so nothing
-- changes about what happens when an account is removed:
--   stories.author_id  ON DELETE SET NULL  (matches the base migration)
--   comments.user_id   ON DELETE CASCADE  (matches the base migration)
--
-- Run this BEFORE the pre-check below fails you. The pre-check returns no rows
-- today. If it ever returns rows, the account exists in auth.users but has no
-- profiles row, and this migration will fail; fix those rows first.
--
--   SELECT s.id, s.slug, s.author_id
--     FROM stories s
--     LEFT JOIN profiles p ON p.id = s.author_id
--    WHERE s.author_id IS NOT NULL AND p.id IS NULL;
--
--   SELECT c.id, c.user_id
--     FROM comments c
--     LEFT JOIN profiles p ON p.id = c.user_id
--    WHERE p.id IS NULL;
--
-- No agent can apply this. Supabase SQL access sits with Taz, the same
-- constraint as BEL-32. This file is the reviewed statement, ready to run.
--
-- The client does not depend on it. StoryDetailPage reads the byline with a
-- second, separate `profiles` query keyed on author_id, so every story page
-- works with or without these keys. Once they exist, the embed hint to use is
-- `stories_author_id_profiles_fkey` (and `comments_user_id_profiles_fkey`
-- for the comment list).
--
-- Safe to re-run: every statement is idempotent.

begin;

-- ============================================================
-- 1. stories.author_id -> profiles.id
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stories_author_id_profiles_fkey'
  ) THEN
    ALTER TABLE stories
      ADD CONSTRAINT stories_author_id_profiles_fkey
      FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
    RAISE NOTICE 'added stories_author_id_profiles_fkey';
  ELSE
    RAISE NOTICE 'stories_author_id_profiles_fkey already present';
  END IF;
END
$$;

-- ============================================================
-- 2. comments.user_id -> profiles.id
-- ============================================================
-- Same defect, same cause, different table. The comment list is contained to
-- the bottom of the story page, so this one shows "Failed to load comments"
-- rather than taking the page down, but it is a real 400 and not a latent one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comments_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE comments
      ADD CONSTRAINT comments_user_id_profiles_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
    RAISE NOTICE 'added comments_user_id_profiles_fkey';
  ELSE
    RAISE NOTICE 'comments_user_id_profiles_fkey already present';
  END IF;
END
$$;

-- ============================================================
-- 3. Index the new key columns
-- ============================================================
-- PostgREST reaches profiles through these keys on every embed. The profiles
-- primary key already covers the lookup; these cover the join side.
CREATE INDEX IF NOT EXISTS idx_stories_author_id ON stories (author_id)
  WHERE author_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments (user_id);

commit;