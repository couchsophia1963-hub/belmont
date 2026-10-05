-- ============================================================
-- stories: refuse a byline the desk has not permitted, at the database
--
-- Issue:   BEL-188, review findings 2, B3 and B6 on PR #24
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
-- The policy alone cannot express "a byline may not be removed". `WITH CHECK`
-- sees only the NEW row, so it cannot distinguish null -> null from
-- non-null -> null, and permitting a null to satisfy it would also permit
-- stripping one. The trigger reads OLD, so it can. Each covers what the other
-- cannot:
--
--   policy   non-null author_id must be a permitted byline   (sees NEW only)
--   trigger  a non-null author_id may not become null        (sees OLD too)
--
-- Removing a byline is refused by the trigger. Leaving an unattributed story
-- unattributed is allowed by the policy. Verified against a real Postgres
-- 18.4 with this repo's own migrations applied verbatim, as `authenticated`
-- with a JWT claim set - not by reading.
--
-- Column-scoped grants are not an alternative. There are no column-level
-- grants anywhere in this schema: the base migration issues none, and
-- 20261005140000 leaves its grant block commented out deliberately.
-- Narrowing UPDATE on `stories` would have to be table-wide and would break
-- the panel's `select=*` read-back - the exact failure 20261005140000
-- documents at length.
--
-- Interaction worth knowing about: `stories_author_id_profiles_fkey` is
-- `ON DELETE SET NULL` (20261005150000, already on main), and Postgres issues
-- that as `UPDATE stories SET author_id = NULL`, which fires a BEFORE UPDATE
-- row trigger. So deleting the profiles row behind a byline is refused rather
-- than nulling the byline. That is the right outcome - a byline cannot be
-- stripped, including by cascade - but it surfaces as a byline error on a
-- profile or auth-user delete. `profiles.id` is ON DELETE CASCADE from
-- `auth.users`, so removing the auth user hits it too. Reassign the byline in
-- byline_roster before removing the account.
--
-- What this does NOT do
-- ---------------------
-- It does not attribute the stories that already have `author_id IS NULL`, and
-- it does not fix the ones whose byline is not a permitted one. Both stay
-- editable in every respect except the byline itself: correcting an excerpt,
-- or the BEL-83 lock write, still works. Attributing them is desk work. Read
-- the counts off the table rather than trusting numbers in comments:
--
--   SELECT count(*) FROM stories WHERE author_id IS NULL;
--
-- A story whose author_id names a profile that is not an active roster row
-- has a non-null byline, so the policy demands that byline be permitted and
-- it is not - so every edit to it is refused until it is given a permitted
-- one. That is the same refusal that stops a prohibited name going out, and
-- it is intended, but it lands on the edit path and belongs in the landing
-- notes rather than being discovered by an editor.
--
-- Verify after applying, as a writer session:
--   -- must fail: an unruled author on a new row
--   INSERT INTO stories (title, slug, excerpt, body, author_id)
--   VALUES ('t', 't-check', 'e', 'b', '<any uuid>');
--
--   -- must fail with 23514: removing a byline
--   UPDATE stories SET author_id = NULL WHERE slug = '<a story that has one>';
--
--   -- must succeed: an ordinary edit to an unattributed story
--   UPDATE stories SET excerpt = 'x' WHERE slug = '<an unattributed story>';
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
-- 2. UPDATE - permitted byline, or null may stay null
-- ============================================================
-- The null branch is back, and the trigger below is what makes it safe.
--
-- Removing it was wrong, and measurably so. `is_permitted_byline(NULL)` is
-- false by construction, so with no null branch this policy refused EVERY
-- update to a story whose author_id was null - not just stripping one, but
-- correcting an excerpt, or the BEL-83 lock write, on any unattributed row.
-- The trigger only fires on non-null -> null, so it cannot fill the gap: the
-- policy was refusing rows it was supposed to leave alone.
--
-- The base migration seeds six stories with author_id omitted, and every
-- story published through the old edge function carries the key owner's id -
-- which is the CTO, seeded inactive. So on a fresh database 6 of 6 seeded
-- stories were uneditable, and in production every API-published story with a
-- not-permitted byline was too. Check it rather than trusting this number:
--
--   SELECT count(*) FROM stories WHERE author_id IS NULL;
--
-- The two rules are complementary, and each covers what the other cannot:
--
--   policy   non-null author_id must be a permitted byline  (sees NEW only)
--   trigger  a non-null author_id may not become null       (sees OLD too)
--
-- Removing a byline is refused by the trigger; leaving an unattributed story
-- unattributed is allowed by the policy.
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

-- ============================================================
-- 4. Make PostgREST see it
-- ============================================================
-- Replaced policies take effect immediately for new statements, but the
-- policy bodies call public.is_permitted_byline(); the function cache is
-- refreshed here so that does not report "could not find" against a stale
-- schema. Inside the transaction, like file 1, so it is delivered on COMMIT.
NOTIFY pgrst, 'reload schema';

commit;