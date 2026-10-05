-- ============================================================
-- stories_admin_delete: also refuse DELETE on a published row
--
-- Issue:  BEL-71
-- Adds:   nothing. No new column, no new table, no grant.
--
-- Version note, and it matters
-- ---------------------------
-- This file was first written as 20261005203000. It was renumbered to
-- 20261005293000 so it sorts last.
--
-- `supabase db push` applies migrations in filename order and **refuses to run a
-- migration whose version is lower than one already applied**, reporting the file
-- as out of order. Three migrations landed on main after this one was written
-- (20261005290000, 20261005291000, 20261005292000), so the original name would
-- have been rejected on the first push, and the guard would have silently never
-- shipped. The failure is quiet: a rejected migration looks like a push that
-- succeeded and did nothing.
--
-- Ordering is not cosmetic here. This file and
-- `20261005123424_..._story_locking.sql` both write `stories_admin_delete`, and
-- the later filename wins. This one must be last, or the locking file lands after
-- it and drops `AND published = false` without any error.
--
-- If you renumber this file again, re-check what sorts above it.
--
-- What is wrong today
-- -------------------
-- `20261005123424_20261005180000_story_locking.sql` requires `locked = false`.
-- That part works and is kept. What is missing is `published`.
--
-- The edge function selects `locked` on its delete path and nothing else, so
-- `published` was never consulted by anything:
--
--   stories_admin_delete  -> role=admin AND locked=false, NOT published
--   function delete path  -> role=admin AND locked,      NOT published
--
-- An admin could delete a live story in one call, and nothing recorded that it
-- had been live. The two layers agreed with each other and both were wrong.
--
-- Why the function change is not enough on its own
-- -------------------------------------------------
-- The function's Supabase client is built with SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS entirely. So this policy is NOT a second guard behind the
-- function's own check -- on the API path it is not consulted at all. It guards
-- only the direct PostgREST path, which is what
-- src/pages/StoryManagerPage.tsx uses:
--
--   await supabase.from('stories').delete().eq('id', id)
--
-- Adding `published = false` here closes that second path too, so the admin
-- panel and the API can no longer disagree about what may be deleted.
--
-- What this deliberately does NOT do
-- -----------------------------------
-- It does not block UPDATE on a locked or published row. A correction is an
-- `update` (BEL-64 rule 2). If this policy blocked edits, a locked story could
-- no longer be corrected, and a story that cannot be corrected is a worse
-- failure than one that can be deleted. `lock` stays narrow: it prevents
-- deletion, and nothing else.
--
-- `20261005200000_stories_lock_column_guard.sql` already restricts who may
-- change `locked` and who may take a locked live story offline. This file does
-- not touch that trigger and the two compose.
--
-- Grants
-- ------
-- This statement creates no column and grants nothing to any role, so there is
-- no column-scoped grant to extend and no privilege to widen. Nothing here can
-- reopen the BEL-15 grants question.
--
-- Deploy order: schema first, then the edge function, then the frontend push.
-- The frontend goes last because the panel's own copy must not describe a
-- refusal the database has not started making. That is truth-in-the-UI, not a
-- schema-cache hazard: `published` has existed since the base schema.
--
-- Who runs this file: a person with dashboard access to hocwwzzawiwkxghvfasg.
-- There is no deploy pipeline in this repository, and BEL-48 means no agent can
-- apply it. It is idempotent, so running it twice is safe.
--
-- Safe to re-run: every statement is idempotent.
--
-- Before you run a `db push`, read `supabase_migrations.schema_migrations`. If it
-- does not record migrations that were applied by hand through the dashboard, the
-- first push will try to replay every file in this directory. Most are
-- replay-tolerant, but the ones that write `stories_admin_delete` are not
-- order-insensitive: replaying them out of order lands whichever ran last, and
-- the wrong one silently removes a guard.

begin;

-- ============================================================
-- 1. Replace the policy
-- ============================================================
-- Postgres has no ALTER POLICY ... USING, so DROP then CREATE is the only way to
-- change one. `db push` applies this file inside a single transaction, so a
-- failed CREATE rolls the DROP back with it and the previous policy survives.
-- There is no window in which the policy is missing.
--
-- `published = false` is the whole change. `locked = false` and the admin role
-- check are carried over unchanged.
DROP POLICY IF EXISTS "stories_admin_delete" ON stories;

CREATE POLICY "stories_admin_delete"
  ON stories FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
    AND locked = false
    AND published = false
  );

commit;

-- ============================================================
-- 2. Post-check
-- ============================================================
-- Run after the commit above. Both must hold.
--
-- 2a. The policy exists with the published guard, and it is the one that won:
--
--   SELECT policyname, cmd, qual FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'stories'
--      AND policyname = 'stories_admin_delete';
--   -- exactly one row, cmd = DELETE, qual names BOTH locked and published
--
-- 2b. Nothing became undeletable by accident. Compare, do not hardcode a count:
--
--   SELECT published, count(*) FROM stories GROUP BY 1 ORDER BY 1;
--
-- Run that count BEFORE and after this file and confirm it is unchanged. Do not
-- compare it against a literal number written into a comment: the moment the
-- newsroom publishes another story the check fails for the wrong reason, and a
-- check people learn to ignore is worse than no check.
--
-- Do not verify this guard with an HTTP DELETE against the live site.
--
-- `DELETE /rest/v1/stories?id=eq.<id>` returns 204 either way: if the policy
-- suppressed the row, and if the policy is somehow absent and the story is really
-- gone. You cannot tell those two outcomes apart from the response, and you
-- cannot wrap an HTTP DELETE in a transaction and roll it back. Verifying a
-- data-loss guard with a live delete risks causing the data loss it checks for.
--
-- Verify inside a transaction instead, so RLS is evaluated exactly as PostgREST
-- would evaluate it and the outcome is discarded either way:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claim.sub = '<an admin uuid from profiles>';
--
--     -- must affect 0 rows: the policy refuses a published story
--     delete from stories where id = '<a published story id>';
--
--     -- control: must affect 1 row, proving the role and policy are actually
--     -- live and that the 0 above came from the guard and not a mis-set claim
--     delete from stories where id = '<an unpublished, unlocked draft id>';
--   rollback;
--
-- Read the admin uuid from `select id, role from profiles where role = 'admin'`.
-- Pick the draft id from the same query rather than assuming one exists; if there
-- is no unpublished draft, create one, note that you did, and remove it after.
--
-- The rollback is what makes this safe against production: whether the policy is
-- in place or not, the live rows survive.