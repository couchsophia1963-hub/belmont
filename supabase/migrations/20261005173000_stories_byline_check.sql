-- ============================================================
-- stories: refuse a byline the desk has not permitted, at the database
--
-- Issue:   BEL-188, review findings 2, B3 and B6 on PR #24
--          BEL-248, the BEL-231 ruling as amended by BEL-274 (P1-P6)
-- Applies: AFTER 20261005172000_byline_roster.sql
-- Adds:    one column, stories.first_published_at. No table, no grant. Two
--          policies are replaced with tighter versions of themselves, and
--          three triggers are added.
--          DEPLOY ORDER: this file must be applied BEFORE the edge function is
--          deployed, because the function reads first_published_at and a
--          function that references a column which does not exist yet fails
--          every write with a 500.
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
-- The policy alone cannot express two things, and both are in here.
--
-- 1. "a byline may not be removed". `WITH CHECK` sees only the NEW row, so it
--    cannot distinguish null -> null from non-null -> null, and permitting a
--    null to satisfy it would also permit stripping one. The trigger reads OLD,
--    so it can.
-- 2. "a byline on a story that HAS BEEN PUBLISHED is changed by an admin-role
--    caller" (BEL-231, amended by BEL-274 P1-P3). The policy's own EXISTS
--    admits writer and admin alike, and neither the row's old `published` value
--    nor its publication history is in view at all.
--
-- Both need OLD, so both move to BEFORE UPDATE triggers. Each covers what the
-- other cannot:
--
--   policy   non-null author_id must be a permitted byline   (sees NEW only)
--   trigger  a non-null author_id may not become null        (sees OLD too)
--   trigger  a published story's byline needs an admin       (sees OLD too)
--
-- Removing a byline is refused by the trigger. Leaving an unattributed story
-- unattributed is allowed by the policy. Verified against a real Postgres
-- 18.4 with this repo's own migrations applied verbatim, as `authenticated`
-- with a JWT claim set - not by reading.
--
-- Why "has been published" and not "is published"   (BEL-274 P3)
-- --------------------------------------------------------
-- `published` is in the writer-reachable update whitelist, and no role guard on
-- the true -> false direction exists anywhere in this repository. The ruling
-- declines to add one: with a single admin account holder, an admin-gated
-- unpublish turns a takedown into a phone call, and rule 3 says an unpublish
-- needs the managing editor's instruction, not the CEO awake. So a gate keyed
-- only on OLD.published is bypassable in three calls under one writer key:
--
--   update { published: false }           unpublish. No guard on this anywhere.
--   update { byline: "a rostered name" }  rewrite the byline. The row reads as
--                                         unpublished, so the gate stands aside.
--   update { published: true }            republish. author_id never changes in
--                                         this call, so a gate that fires on
--                                         "the byline changed" does not fire.
--
-- The story goes live carrying a byline no admin ever approved, and nothing in
-- the log distinguishes it from an ordinary correction. That is why this file
-- adds `stories.first_published_at`: a marker recording that a row has been
-- published at least once, set by trigger, which no caller can clear. Both
-- gates read the marker, not the flag, so the flag stays free to move in both
-- directions and the history is not.
--
-- Column-scoped grants are not an alternative to any of this. There are no
-- column-level grants anywhere in this schema: the base migration issues none,
-- and 20261005140000 leaves its grant block commented out deliberately.
-- `authenticated` holds a table-level UPDATE on `stories`, which covers a column
-- added afterwards, so first_published_at is writable by a writer from the
-- moment it exists - which is why the trigger below has to ignore whatever a
-- caller sends rather than trust the column. Read before applying, per the
-- standing rule:
--
--   select grantee, privilege_type, count(*)
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'stories'
--    group by 1, 2 order by 1, 2;
--
-- Expected: no row narrower than the table. A genuine column-scoped grant here
-- would have to be extended in this same change, and this file grants nothing,
-- so it cannot do that itself.
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
-- or the BEL-83 lock write, still works - with one exception below.
-- Attributing them is desk work, and on a story that has been published it is
-- ADMIN work, which is the ruling rather than an accident of this file. Read
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
-- Those two refusals COMPOUND, and this is the one operational consequence of
-- this file that an editor would otherwise meet as a broken deploy:
--
--   the policy    refuses an unruled byline in the NEW row
--   the gate      refuses a writer's change of a byline on a published row
--
-- So on a story that has been published AND carries an unruled byline, neither
-- passes: the writer is refused for changing a live byline, and would be refused
-- for naming a name that is not on the roster if they could. Only an admin can
-- repair it. The base migration seeds six stories with no author, and every story
-- published through the old edge function carries the key owner's id, which is
-- seeded not-permitted - so this is not an edge case, it is most of the existing
-- table. Count it before this file lands and have the admin account holder work
-- through the list; the panel cannot do it, because the byline picker is
-- create-only.
--
--   SELECT count(*) FROM stories s
--    WHERE s.author_id IS NOT NULL
--      AND NOT public.is_permitted_byline(s.author_id);
--
-- This is the ruling working, not a defect: it is what "a byline names a
-- colleague and asserts who did work" means when the name is wrong. But it is a
-- second gate doing a second thing, and the landing notes should say so.
--
-- The conservative backfill, stated as something to check rather than trust:
--
--   SELECT count(*) FILTER (WHERE first_published_at IS NULL) AS never_published,
--          count(*) FILTER (WHERE published) AS live_now,
--          count(*) AS total
--     FROM stories;
--
-- never_published should be 0 straight after applying, because every pre-existing
-- row is stamped. If it is not, the UPDATE did not reach every row and the gate
-- below is not holding on the rows it missed.
--
-- Verify after applying, as a writer session:
--   -- must fail: an unruled author on a new row
--   INSERT INTO stories (title, slug, excerpt, body, author_id)
--   VALUES ('t', 't-check', 'e', 'b', '<any uuid>');
--
--   -- must fail with 23514: removing a byline
--   UPDATE stories SET author_id = NULL WHERE slug = '<a story that has one>';
--
--   -- must fail with 42501: changing the byline of a story that has been live
--   UPDATE stories SET author_id = '<another permitted byline>'
--    WHERE slug = '<a story that has been published>';
--
--   -- must fail with 42501: the bypass this file exists to close, all three
--   -- calls in one session
--   UPDATE stories SET published = false WHERE slug = '<the same story>';
--   UPDATE stories SET author_id = '<another permitted byline>'
--    WHERE slug = '<the same story>';
--   UPDATE stories SET published = true WHERE slug = '<the same story>';
--
--   -- must succeed, and change nothing: clearing the marker is ignored
--   UPDATE stories SET first_published_at = NULL
--    WHERE slug = '<the same story>';
--   SELECT first_published_at FROM stories WHERE slug = '<the same story>';
--
--   -- as an admin session, the same rename must succeed
--   -- (same statement)
--
--   -- must succeed: an ordinary edit to an unattributed story
--   UPDATE stories SET excerpt = 'x' WHERE slug = '<an unattributed story>';
--
--   -- must succeed: correcting copy on a live story, byline resent unchanged
--   UPDATE stories SET excerpt = 'x', author_id = '<its current byline>'
--    WHERE slug = '<a story that has been published>';
--
-- Safe to re-run: every statement is idempotent. The marker trigger is
-- `UPDATE OF published, first_published_at`, so re-applying the backfill is a
-- no-op for any row already stamped - and it cannot clear one, because the
-- backfill only ever writes to rows where the column IS NULL.

begin;

-- ============================================================
-- 1. stories.first_published_at: has this row ever been live?
-- ============================================================
-- Additive and immutable. This is the whole of BEL-274 P3.
--
-- What it is NOT: a second copy of `published`. `published` says the row is on
-- the site now and a writer may move it in both directions. This column says the
-- row has been on the site at least once, and nothing may move it back.
--
-- The backfill is deliberately conservative: EVERY existing row is stamped, not
-- only the rows that are live at the moment this runs. The alternative
-- (`where published`) is one word shorter and reads better, and it is wrong for
-- exactly the rows the ruling is about - a story that was published and has
-- since been pulled back to a draft has no evidence of that in this table, so
-- it would arrive with a null marker and its byline would be writer-changeable.
-- There is no column anywhere in this schema that records publication history,
-- so the only safe assumption for a row that already exists is that it has been
-- seen. That errs towards requiring an admin for some bylines that never went
-- out, which is the direction where the cost is an inconvenience.
--
-- `created_at` rather than now(): the row existed before this migration, and
-- stamping it with the migration's own timestamp would date every historical
-- story to today. Either way the marker is only ever tested for null, so the
-- exact instant is not load-bearing - it is recorded to be readable.
ALTER TABLE stories ADD COLUMN IF NOT EXISTS first_published_at timestamptz;

UPDATE stories
   SET first_published_at = coalesce(created_at, now())
 WHERE first_published_at IS NULL;

COMMENT ON COLUMN stories.first_published_at IS
  'When this story was first published. Set by trigger, never cleared, never settable by a caller. The byline-authority gate reads this rather than published, because published is in the writer update whitelist and an OLD.published gate is bypassable by unpublishing first. See BEL-274 P3.';

-- ============================================================
-- 2. The marker itself: a trigger, because a writer can write the column
-- ============================================================
-- `authenticated` has table-level UPDATE on `stories`, so the column is writable
-- by any writer. A DEFAULT would not help - a caller that names the column
-- overrides a default - and a CHECK constraint cannot see OLD either. So the
-- value is decided here, and whatever arrived in NEW is discarded:
--
--   INSERT  marker = now() if the row is being created published, else null.
--           Anything the caller supplied is ignored, including a supplied value
--           on an unpublished row.
--   UPDATE  a row that already has a marker keeps it, whatever the caller sent,
--           including null. That is the load-bearing line: `SET
--           first_published_at = NULL` is silently ignored rather than obeyed.
--           A row with no marker that becomes published is stamped now().
--
-- The consequence worth stating: a writer cannot un-stamp a row, and cannot
-- pre-stamp a draft to lock themselves out of their own byline. The only lever
-- they have is leaving published false, which is legitimate - the gate asks
-- whether the row has been live, and a row that never was does not need an
-- admin.
--
-- BEFORE, so the value written is the value stored. An operator in SQL can set
-- or clear the column with `set session_replication_role`, which is the same
-- deliberate-bypass answer the strip trigger below gives, and no application
-- caller can reach it.
CREATE OR REPLACE FUNCTION public.stories_set_first_published_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Ignores NEW.first_published_at entirely.
    IF NEW.published IS TRUE THEN
      NEW.first_published_at := coalesce(NEW.first_published_at, now());
    ELSE
      NEW.first_published_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.first_published_at IS NOT NULL THEN
    -- Already been live. The marker's value is not the caller's to change, and
    -- this is what makes the three-call bypass fail.
    NEW.first_published_at := OLD.first_published_at;
  ELSIF NEW.published IS TRUE THEN
    -- First time this row goes live.
    NEW.first_published_at := coalesce(NEW.first_published_at, now());
  ELSE
    NEW.first_published_at := NULL;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.stories_set_first_published_at() IS
  'Maintains stories.first_published_at: stamps a row the first time it is published and never lets a caller change or clear the stamp. The byline-authority gate reads it because published is writer-writable.';

DROP TRIGGER IF EXISTS stories_set_first_published_at ON stories;
CREATE TRIGGER stories_set_first_published_at
  BEFORE INSERT OR UPDATE OF published, first_published_at ON public.stories
  FOR EACH ROW
  EXECUTE FUNCTION public.stories_set_first_published_at();

-- ============================================================
-- 3. INSERT - caller is a writer, AND the byline is permitted
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
-- 4. UPDATE - permitted byline, or null may stay null
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
-- 5. A byline cannot be removed
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
-- 6. A byline on a story that has been published needs an admin
-- ============================================================
-- Mara Vance's ruling on BEL-231 as amended by BEL-274, 2026-10-05:
--
--   "A byline change on a row that HAS BEEN PUBLISHED is refused unless the
--    caller's profiles.role is admin - on both write paths."
--
-- P1 through P6 are the properties the ruling signs. This section is P1 and P3
-- on the panel path. P4 is the policy above and is unchanged by this. P5 is
-- what NOT to add: no unpublish, no delete, no lock. P6 is that an admin caller
-- with no instruction from the managing editor has still broken the ruling, so
-- nothing here should be read as making a byline change correct on its own.
--
-- It reads `OLD.first_published_at`, NOT `OLD.published`. That is the whole of
-- P3, and it is the difference between a gate that holds and one that does not:
-- `published` is writer-writable with no role guard on the true -> false
-- direction, so unpublish, rename, republish is three calls and the third one
-- never touches the byline. Section 1's marker is what makes this gate survive
-- that sequence, and section 2 is what stops the marker being cleared to let it
-- through.
--
-- A second trigger rather than a second condition in the one above, because they
-- answer different questions and should be droppable independently:
-- `stories_byline_not_stripped` owns removal, this one owns authority. Neither
-- mutates the row - they raise or they pass NEW through - so they compose with
-- each other and with the two guards `main` has since added on this table
-- (`stories_guard_lock_columns` from BEL-213, `stories_log_byline_change` from
-- BEL-249). Postgres fires BEFORE row triggers in name order, so the order here
-- is alphabetical and none of it is load-bearing.
--
-- The edge function enforces the same rule in `update`, and it has to: the
-- function's client is built with SUPABASE_SERVICE_ROLE_KEY, which carries
-- BYPASSRLS, so this trigger is not its gate there at all. Measured rather than
-- assumed - as service_role `auth.uid()` is null, and section 2 of the ruling's
-- administration means a null uid is also an operator at the SQL editor. So the
-- two guards are not redundant: remove the one in the function and this rule is
-- not enforced on the API at all.
--
-- The four ways an UPDATE can read here, and what each one does:
--
--   marker null,       author changing       not this rule. The row has never
--                                           been live, so the byline is the
--                                           writer's to set; the policy's roster
--                                           check still applies.
--   marker set,        author NOT changing   not this rule. A writer correcting
--                                           the copy of a live story may resend
--                                           the byline it already carries, and
--                                           refusing that would close the
--                                           correction path the ruling
--                                           explicitly keeps open (P5).
--   marker set,        author -> NULL        not this rule either. The strip
--                                           trigger above refuses that for every
--                                           caller, so it keeps its own message
--                                           and its own 23514.
--   marker set,        author changing       this rule.
--
-- Note that the row being republished in the same statement does not change any
-- of those four answers. A writer republishing an unchanged byline is not a byline
-- change and is allowed, which is what P5 needs; a writer renaming the byline in
-- the same call as republishing it is refused, because the marker was already set
-- before the statement began.
--
-- ERRCODE 42501 is insufficient_privilege, the SQLSTATE an RLS refusal itself
-- raises, and PostgREST maps it to 403. Using the same code means a direct
-- PostgREST caller cannot tell this trigger's refusal from a policy's, and sees
-- the status the function returns for the same act. The message carries the rule
-- and the ruling, because an editor who hits it in the panel needs to know it is
-- an authority rule and not a bug.
--
-- A null `auth.uid()` returns NEW, for the same reason BEL-213's guard does and
-- with the same two branches: `anon` cannot update stories at all (no UPDATE
-- policy, and the writer policy's EXISTS is false for a null uid), and an
-- operator in SQL is not a newsroom caller. An operator whose every attempt to
-- fix a live byline is refused by a trigger cannot land the correction this
-- ruling depends on.
CREATE OR REPLACE FUNCTION public.stories_byline_authority_on_published()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  caller_is_admin boolean;
BEGIN
  -- Not a session caller. See above: RLS does not govern these, and the
  -- function guards its own path.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Never been on the site, so no reader has seen this byline. A draft's byline
  -- is the writer's to set. This is the branch the three-call bypass in the
  -- header used to reach, and section 1 closes it.
  IF OLD.first_published_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Nothing changed, so nothing is being asserted about anyone. This is the
  -- branch that keeps copy corrections open on a live story (P5).
  IF NEW.author_id IS NOT DISTINCT FROM OLD.author_id THEN
    RETURN NEW;
  END IF;

  -- Removal, not a change of byline. The trigger above refuses it for every
  -- caller and keeps its own message; standing aside here keeps the two rules
  -- separable and keeps a strip refusal reporting as a strip refusal.
  IF NEW.author_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT (profiles.role = 'admin') INTO caller_is_admin
    FROM public.profiles
   WHERE profiles.id = auth.uid();

  -- Fail closed: an authenticated caller with no profiles row, or with any role
  -- that is not admin, is refused.
  IF coalesce(caller_is_admin, false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'a byline on a story that has been published is changed by an admin-role caller, on the managing editor''s instruction on the story''s task (BEL-231, as amended by BEL-274 P1). Correcting the copy of this story does not need an admin caller: send the update without author_id. Unpublishing first is not required and is not the answer - a byline correction is an update, not an unpublish, and unpublishing does not clear the requirement.'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMENT ON FUNCTION public.stories_byline_authority_on_published() IS
  'Refuses a byline change on a story that has ever been published, by a non-admin caller. Per BEL-231 as amended by BEL-274 P1. Reads OLD, which the RLS policy cannot, and reads stories.first_published_at rather than published, which a writer can move. Mirrored in the update action of supabase/functions/api, which service_role would otherwise bypass this.';

DROP TRIGGER IF EXISTS stories_byline_authority_on_published ON stories;
CREATE TRIGGER stories_byline_authority_on_published
  BEFORE UPDATE ON public.stories
  FOR EACH ROW
  EXECUTE FUNCTION public.stories_byline_authority_on_published();

-- ============================================================
-- 7. Make PostgREST see it
-- ============================================================
-- Replaced policies take effect immediately for new statements, but the
-- policy bodies call public.is_permitted_byline(); the function cache is
-- refreshed here so that does not report "could not find" against a stale
-- schema. Inside the transaction, like file 1, so it is delivered on COMMIT.
NOTIFY pgrst, 'reload schema';

commit;