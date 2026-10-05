-- ============================================================
-- stories: refuse a byline the desk has not permitted, at the database
--
-- Issue:   BEL-188, review finding 2 on PR #24
-- Applies: AFTER 20261005170000_byline_roster.sql
-- Adds:    no table, no column, no grant. Two policies are replaced with
--          tighter versions of themselves.
--
-- Why
-- ---
-- PR #24 fixes the edge function: it stops taking the byline from the
-- bearer token. That is not sufficient, because `stories` is also written
-- directly over PostgREST, as `authenticated`, by the admin panel:
--
--   StoryManagerPage.tsx:100   authorId={userId}
--   StoryManagerPage.tsx:495   .insert({ ...payload, author_id: authorId })
--
-- `authorId` is `session.user.id`, hard-wired. So the panel has the exact
-- defect the function had, and after PR #24 it is the one writer left
-- unguarded. The base policy is why:
--
--   stories_writer_insert  WITH CHECK (
--     EXISTS (... profiles.role IN ('writer','admin'))   -- who is writing
--   )                                                     -- nothing about
--                                                          -- what they name
--
-- The policy constrains the caller and never `author_id`, so any writer
-- may attribute a story to any profile id in the database. Enforcing the
-- ruling on one of two write paths is not enforcement.
--
-- So enforce it here, where every client is subject to it - the panel, a
-- `curl`, a future integration, and the edge function if it ever stops
-- using the service role. The function still does its own check, because
-- service_role bypasses RLS and its refusals carry better messages.
--
-- The same check on both paths, from one function: the ruling cannot be
-- enforced one way on the panel and another way in the function.
--
-- What this does NOT do
-- ---------------------
-- It does not make an existing wrong byline wrong-er. The 7 seed rows
-- carry `author_id IS NULL` and this file leaves them alone: the UPDATE
-- check explicitly permits a null author_id, so editing the body of an
-- unattributed row still works. Backfilling those rows is desk work, not
-- schema work.
--
-- Verify before relying on it:
--   -- as authenticated, with a writer session, this must fail:
--   INSERT INTO stories (title, slug, excerpt, body, author_id)
--   VALUES ('t', 't', 't', 't', '<any uuid>');
--
--   -- and this must succeed, once byline_roster.profile_id is filled in
--   -- and profiles.display_name matches byline_roster.byline:
--   SELECT public.is_permitted_byline('<the byline profile id>');
--
-- Safe to re-run: every statement is idempotent.

begin;

-- ============================================================
-- 1. INSERT - caller is a writer, AND the byline is permitted
-- ============================================================
-- author_id must be non-null here. `is_permitted_byline(NULL)` is false,
-- because no roster row can have a null profile_id, so a new row with no
-- author is refused rather than published unattributed.
DROP POLICY IF EXISTS "stories_writer_insert" ON stories;
CREATE POLICY "stories_writer_insert"
  ON stories FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
    AND public.is_permitted_byline(author_id)
  );

-- ============================================================
-- 2. UPDATE - same, but a null author_id stays legal
-- ============================================================
-- The 7 existing rows have author_id IS NULL. Without the explicit null
-- branch this policy would make them uneditable: any body correction on an
-- unattributed story would be refused. So a null is allowed to remain
-- null, but any non-null value a writer supplies must be a permitted
-- byline - which is what makes a byline correctable rather than permanent.
DROP POLICY IF EXISTS "stories_writer_update" ON stories;
CREATE POLICY "stories_writer_update"
  ON stories FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
    AND (author_id IS NULL OR public.is_permitted_byline(author_id))
  );

commit;

-- ============================================================
-- 3. Make PostgREST see it
-- ============================================================
-- Replaced policies take effect immediately for new statements, but the
-- admin panel calls public.permitted_bylines() through PostgREST and the
-- policy bodies call public.is_permitted_byline(); the function cache is
-- refreshed here so neither reports "could not find" against a stale
-- schema. Delivered on COMMIT.
NOTIFY pgrst, 'reload schema';