-- ============================================================
-- stories: refuse a byline the desk has not permitted, at the database
--
-- Issue:   BEL-188, review findings 2 and B3 on PR #24
-- Applies: AFTER 20261005172000_byline_roster.sql
-- Adds:    no table, no column, no grant. Two policies are replaced with
--          tighter versions of themselves, and one trigger is added.
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
-- Why a trigger and not just the policy's null branch
-- ---------------------------------------------------
-- The obvious way to keep unattributed rows editable is to let the UPDATE
-- policy accept a null author_id:
--
--   WITH CHECK (... AND (author_id IS NULL OR is_permitted_byline(author_id)))
--
-- That was the first draft of this file and it is wrong. `WITH CHECK` sees
-- only the **new** row. It cannot tell null -> null from non-null -> null,
-- so that policy also permits
--
--   UPDATE stories SET author_id = NULL WHERE id = <any story>
--
-- for any writer on any row, including a published headline. The edge
-- function refuses exactly that - "Refusing rather than writing a null
-- author_id, which is unattributed copy" - so the policy would permit what
-- the function forbids. That is the one disagreement this file exists to
-- eliminate. A policy cannot express "null is allowed to stay null"; only
-- the OLD row can answer it, so the check moves to a BEFORE UPDATE trigger
-- below.
--
-- Column-scoped grants are not the alternative. There are no column-level
-- grants anywhere in this schema: the base migration issues none, and
-- 20261005140000 leaves its grant block commented out deliberately.
-- Narrowing UPDATE on `stories` would have to be table-wide and would break
-- the panel's `select=*` read-back - the exact failure 20261005140000
-- documents at length.
--
-- What this does NOT do
-- ---------------------
-- It does not fix the stories that already have `author_id IS NULL`. It
-- leaves them editable in every other respect - the trigger only fires on a
-- non-null becoming null - so correcting the body of an unattributed row
-- still works, and nothing about this migration makes an existing row worse.
-- Attributing those rows is desk work. Read the count off the table rather
-- than trusting a number in a comment:
--
--   SELECT count(*) FROM stories WHERE author_id IS NULL;
--
-- Verify before relying on it:
--   -- as authenticated, with a writer session, these must fail:
--   INSERT INTO stories (title, slug, excerpt, body, author_id)
--   VALUES ('t', 't', 't', 't', '<any uuid>');
--
--   UPDATE stories SET author_id = NULL WHERE id = '<a story that has one>';
--
--   -- and this must return true, once byline_roster.profile_id is filled in
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
-- 2. UPDATE - same, and the null case is left to the trigger
-- ============================================================
-- No null branch here, deliberately. Every non-null author_id must be a
-- permitted byline, and the null case is handled by the trigger below
-- rather than by weakening this policy. Splitting it this way keeps one
-- rule in the policy (is this byline permitted?) and one in the trigger
-- (is this byline being removed?), instead of one condition trying to
-- express both.
--
-- The UPDATE policy still requires a permitted byline on the NEW row, so
-- `UPDATE ... SET author_id = <unruled uuid>` is refused here. The
-- `author_id IS NULL` case is what the policy cannot judge: for a row that
-- was already null it should pass, and for a row that had a byline it must
-- not.
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
    AND public.is_permitted_byline(author_id)
  );

-- ============================================================
-- 3. A byline cannot be removed
-- ============================================================
-- This is the check the policy cannot make. It reads OLD, so it can tell
-- null -> null (an ordinary edit to an already-unattributed row, allowed)
-- from non-null -> null (stripping a byline, refused).
--
-- ERRCODE 23514 is check_violation, which is what PostgREST surfaces as a
-- policy-style refusal rather than a 500, so the panel's create error
-- handler reads it correctly.
--
-- Raising on every writer and admin is intentional. Removing a byline is
-- not a correction anyone has asked for; correcting a wrong byline means
-- naming a permitted one, which the policy above accepts. If the desk ever
-- wants de-attribution as an explicit operation, that is a deliberate
-- migration with a deliberate bypass - not a side effect of an UPDATE.
--
-- BEFORE UPDATE, so it runs before the row is written and cannot leave a
-- half-applied state.
CREATE OR REPLACE FUNCTION public.stories_byline_not_stripped()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.author_id IS NOT NULL AND NEW.author_id IS NULL THEN
    RAISE EXCEPTION
      'byline cannot be removed from a story; name a permitted byline instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.stories_byline_not_stripped() IS
  'Refuses non-null -> null on stories.author_id. The RLS policy cannot see the OLD row, so stripping a byline needs a trigger.';

DROP TRIGGER IF EXISTS stories_byline_not_stripped ON stories;
CREATE TRIGGER stories_byline_not_stripped
  BEFORE UPDATE ON public.stories
  FOR EACH ROW
  EXECUTE FUNCTION public.stories_byline_not_stripped();

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