-- ============================================================
-- comments: a public thread through a narrow view, not the table
--
-- Issue:           BEL-34
-- Board decision:  2026-10-05, "public comments, narrow view"
-- Requires:        nothing. NOT 20261005150000_author_profiles_fk.sql. The view
--                  joins with a plain LEFT JOIN, which needs no foreign key,
--                  and the FK migration does not reference this view. An earlier
--                  version of this header claimed that dependency and it was
--                  wrong; it also chained BEL-40 behind BEL-39 for no reason.
-- Real prerequisite: BEL-48. The Supabase tool connection is bound to the
--                  Shipwright project, so this file must be run against the
--                  Belmont News project instead. That is a connection or
--                  dashboard decision, not a migration ordering one.
-- Does not touch:   profiles.
--
-- What is open today
-- ------------------
--   comments_public_read ON comments FOR SELECT TO anon, authenticated USING (true)
--
-- The table is empty, so nothing leaks yet. That is a fact about the table, not
-- about the policy: the moment one reader comments, every comment body and every
-- commenter user_id is readable with the public anon key, and it accumulates with
-- every comment. `comments_public_read` is `TO anon`, so RLS will not filter it.
--
--   GET /rest/v1/comments?select=*
--     -> 200, content-range: */*, []      # empty because there are no rows
--
-- This migration makes the empty table unnecessary as a safety property.
--
-- What it does
-- ------------
--   1. Adds public.comments_public: id, story_id, body, created_at, display_name.
--      No user_id, no email, no role, nothing enumerable. The name comes from the
--      LEFT JOIN, so a deleted account leaves a null display_name instead of
--      dropping the comment out of the thread.
--   2. Grants that view to anon and authenticated. This is the only path an
--      anonymous reader has to a comment.
--   3. Drops comments_public_read and replaces it with the same scope
--      comments_owner_or_admin_delete already uses, so "rows you can read" is
--      exactly "rows you can delete": your own comments, or all of them if you
--      are an admin. No client-side role check is needed to keep that true.
--
-- What it does not do
-- --------------------
--   It does not touch profiles_public_read. profiles is still world-readable,
--      and that is BEL-31's decision to make, not this migration's. The view adds
--      no new exposure: display_name is already readable by anon today.
--
-- Why the view is security_invoker = off (the default)
-- ---------------------------------------------------
-- The view must bypass the comments policies, otherwise anonymous readers get
-- nothing: the policies below deliberately exclude them. That is the point of the
-- view -- it is the published surface, and it publishes five columns and no
-- identifiers. security_invoker = on would route the read through comments RLS
-- and hand anonymous readers an empty thread.
--
-- Pre-checks. Both must return 0. Do not skip them.
--   SELECT count(*) AS orphan_comments
--     FROM comments c LEFT JOIN profiles p ON p.id = c.user_id
--    WHERE p.id IS NULL;
--   SELECT count(*) AS comment_rows FROM comments;
--
-- Post-check. The table must read empty for anon, the view must not:
--   GET /rest/v1/comments?select=*                -> 200, [] (RLS denies)
--   GET /rest/v1/comments_public?select=*        -> 200, Content-Range matching the
--                                                    real comment count
--
-- Safe to re-run: every statement is idempotent, and the view is dropped and
-- recreated rather than replaced so that a view left with security_invoker = on
-- by an earlier attempt can be corrected.
--
-- Who runs this file: not an agent, and not only Taz. Every Supabase tool
-- connection currently bound in this company points at the Shipwright project,
-- which has no comments table and no profiles table, so the transaction aborts
-- with 42P01 and rolls back. Either repoint the connection (BEL-48) or open the
-- Belmont News project in the Supabase dashboard and paste this file. It is
-- idempotent, so running it twice is safe. This is the constraint from BEL-32,
-- BEL-39 and BEL-48.

begin;

-- ============================================================
-- 1. The published surface
-- ============================================================
DROP VIEW IF EXISTS public.comments_public;

CREATE VIEW public.comments_public
  WITH (security_invoker = off)
  AS
  SELECT
    c.id,
    c.story_id,
    c.body,
    c.created_at,
    p.display_name
  FROM public.comments c
  LEFT JOIN public.profiles p ON p.id = c.user_id;

ALTER VIEW public.comments_public OWNER TO postgres;

REVOKE ALL ON public.comments_public FROM PUBLIC;
GRANT SELECT ON public.comments_public TO anon, authenticated;

-- ============================================================
-- 2. Close the table
-- ============================================================
DROP POLICY IF EXISTS "comments_public_read" ON comments;

DROP POLICY IF EXISTS "comments_owner_or_admin_read" ON comments;
CREATE POLICY "comments_owner_or_admin_read"
  ON comments FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- anon gets no policy on comments, so RLS denies every row. Insert, update and
-- delete are untouched: comments_user_insert, comments_owner_update and
-- comments_owner_or_admin_delete already scope to the author and to admins.

commit;
