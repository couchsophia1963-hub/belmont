-- ============================================================
-- story_byline_changes: a byline change as a row, not as updated_at
--
-- Issue:   BEL-249 (ruling: byline-authority, BEL-231, 2026-10-05,
--          Mara Vance, managing editor. Attribution policy only.)
-- Adds:    one table, one index set, two functions, one trigger. No change
--          to any existing table, policy, column or grant.
-- Requires: nothing. Applies independently of PR #24 (BEL-188) and in
--          either order. See "Ordering" below, because it matters.
--
-- What is wrong today
-- -------------------
-- A byline change on a published story is visible only as `stories.updated_at`
-- moving. Three facts and no more: the row moved, and that is all. There is no
-- record of who made the change, what the byline was before, what it is after,
-- or why. Anyone who can UPDATE `stories` can change any byline on any row and
-- leave exactly the same trace as an editor fixing a typo in the body.
--
-- The managing editor's instruction on the story's task - old byline, new
-- byline, reason, who, when - is durable and is in force now. It is weaker
-- than a database row in three ways, and this migration closes all three:
--
--   1. prose, so not queryable        -> closed: these are typed columns
--   2. not atomic with the write      -> closed: the trigger is in the write's
--                                         own transaction, so a byline change
--                                         that cannot be recorded does not land
--   3. editable after the fact        -> closed: no UPDATE, no DELETE, no
--                                         INSERT for any role, at the database
--
-- What this table DOES guarantee, stated plainly
-- ----------------------------------------------
--   * Every change to `stories.author_id` on any row writes exactly one row
--     here, in the same transaction. If this insert fails, the UPDATE rolls
--     back. There is no path that changes a byline and leaves no record.
--   * The row records both bylines as they were, both profile ids, who made
--     the change, when, the reason, and the task reference.
--   * The row survives deletion of the story and deletion of the profiles it
--     names. There are no foreign keys on this table, deliberately (see
--     "Survivability").
--   * No role can UPDATE or DELETE a row here, and no role can INSERT one
--     except the trigger function itself. Both locks are independent: the
--     grants are revoked AND there is no RLS policy permitting the write.
--
-- What this table does NOT guarantee
-- ----------------------------------
--   * It does not attribute a change made by `service_role` that did not go
--     through `public.change_story_byline()`. The edge function connects as
--     service_role, which has no `auth.uid()`, so there is no identity to
--     read. Such a row is written with `changed_by_profile_id IS NULL` and
--     `actor_source = 'unknown'`, and it says so rather than guessing. The
--     landing test asserts this case and the post-check counts it:
--
--       SELECT actor_source, count(*) FROM story_byline_changes GROUP BY 1;
--
--     Closing it is a one-line change in the edge function, in a PR that lands
--     AFTER this migration. Rule 1: schema first.
--   * It does not attribute a change to `profiles.display_name`. Renaming a
--     profile re-renders the byline on every published story by that author,
--     and touches no `stories` row, so no trigger on `stories` can see it.
--     That is a real gap and it is not in scope here - whether a display-name
--     change counts as a byline change is an editorial question, not a schema
--     one. Raised to the managing editor separately. Recorded here so the next
--     reader of this file knows it was considered and not missed.
--   * It does not backfill. There is no prior history to backfill; the old
--     trace was `updated_at` and it is not reconstructible from `updated_at`.
--     This table starts empty, at the first byline change after it lands.
--   * It does not prove who *typed* the change, only which credential's
--     session performed it. `actor_source` records which of those it was.
--
-- Ordering
-- --------
-- This file must be applied before any edge function or panel change that
-- relies on `public.change_story_byline()`. It does not have to be applied
-- after PR #24, and it must not wait for it:
--
--   * It reads `stories.author_id`, `stories.slug` and `profiles.display_name`,
--     all of which exist since the base migration.
--   * It references nothing from `byline_roster` and nothing from
--     `is_permitted_byline()`.
--   * PR #24's `stories_byline_not_stripped` trigger refuses non-null -> null
--     on `author_id`. If both are applied, a byline cannot be removed and so
--     this table never records a removal. If only this file is applied, a
--     removal is possible and is recorded - which is why `new_byline_profile_id`
--     is nullable here rather than NOT NULL. The table is correct either way
--     and does not assume the other migration landed.
--
-- Grants, read before the write
-- -----------------------------
-- The Supabase default is table-level grants, and this schema issues no
-- column-scoped GRANT anywhere except `comments_public`, a view (see
-- `20261005160000_comments_public_view.sql:102-103`). So there is no read grant
-- to extend here and no half-working panel to worry about: nothing in this
-- repository reads this table yet, and the migration adds no frontend.
--
-- What it grants, and what it refuses:
--
--   SELECT   -> `authenticated`, but only writers and admins, by RLS. Not anon.
--              The history is newsroom-internal. This is not a new exposure
--              class: `profiles` is already world-readable to anon (BEL-31,
--              a decision the desk has made and this file does not reopen).
--   SELECT   -> `service_role`, for the operator's own verification query.
--   INSERT   -> nobody. The trigger function is SECURITY DEFINER and writes as
--              the table owner, so it needs no grant and no caller gets one.
--   UPDATE   -> nobody. Not even an admin.
--   DELETE   -> nobody. Not even an admin, and not service_role.
--
-- Two independent locks on the immutability claim, because either one alone is
-- a single point of failure:
--
--   1. Grants are revoked from PUBLIC, anon, authenticated and service_role.
--   2. RLS is enabled and there is exactly one policy, and it is SELECT-only.
--      Even a grant added later by hand writes nothing.
--
-- The one role that can still change these rows is the table owner, by
-- dropping the trigger or the policies. That is true of every audit table in
-- Postgres and is why the guarantee is stated as "no role", not "no one".
--
-- Survivability: why there are no foreign keys here
-- -------------------------------------------------
-- The ruling's record must outlive the things it describes. Two decisions
-- follow, and both are deliberate:
--
--   * `story_id` has NO foreign key. `ON DELETE CASCADE` would erase the
--     history when a story is deleted, which is the opposite of what an
--     attribution record is for. `ON DELETE SET NULL` would keep the row and
--     throw away which story it was. `story_slug` is stored alongside it as a
--     text snapshot, so a deleted story's byline history is still legible.
--   * `old_byline_profile_id`, `new_byline_profile_id` and
--     `changed_by_profile_id` have NO foreign key either, and the byline names
--     are stored as text snapshots of `profiles.display_name` at the moment of
--     the change.
--
-- `byline_roster.profile_id` uses `ON DELETE SET NULL`, and this file
-- deliberately does not copy that choice, per the design question on BEL-249.
-- The difference in kind: `byline_roster` is a rule ("this name may write"),
-- and losing the profile means losing the rule, so SET NULL is right there. This
-- table is a historical record ("this name was on this story until 14:02"), and
-- SET NULL would destroy the fact the row exists to state.
--
-- A foreign key with `ON DELETE NO ACTION` was considered and rejected: it
-- would make an audit row block deletion of the auth user behind it, which is
-- a new failure mode that does not exist today and would surface as an
-- unexplained `23503` on account removal. An audit trail that can block a
-- routine operation is an audit trail that gets deleted wholesale.
--
-- Consequently the profile ids here are historical labels, not live
-- references. Nothing in this file promises referential integrity, and the
-- header says so rather than implying it.
--
-- Landing test
-- ------------
-- `supabase/tests/story_byline_changes.test.sql`. It runs in a transaction and
-- rolls back, so it is safe to paste into the live project. It asserts the
-- guarantees above and, deliberately, the one path that records no actor.
--
-- Post-check after applying:
--
--   SELECT actor_source, count(*) FROM story_byline_changes GROUP BY 1;
--   -- 'unknown' should be 0 rows on a fresh table and is the count to watch
--
--   SELECT story_id, old_byline_name, new_byline_name, changed_by_name, changed_at
--     FROM story_byline_changes ORDER BY changed_at DESC LIMIT 10;
--
-- Safe to re-run: every statement is idempotent, and the trigger and policies
-- are dropped and recreated rather than replaced.

begin;

-- ============================================================
-- 1. The table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.story_byline_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The story, as a label. No FK: see "Survivability".
  story_id uuid NOT NULL,
  story_slug text NOT NULL,

  -- Both bylines, as they were. Nullable because a row that had no byline and
  -- gained one is a change, and that is a real state of this database today.
  old_byline_profile_id uuid,
  old_byline_name text NOT NULL DEFAULT '',
  new_byline_profile_id uuid,
  new_byline_name text NOT NULL DEFAULT '',

  -- Who made the change. Nullable on purpose: see the "does NOT guarantee"
  -- section. A row with no actor says so; it never carries a guessed one.
  changed_by_profile_id uuid,
  changed_by_name text NOT NULL DEFAULT '',
  actor_source text NOT NULL DEFAULT 'unknown'
    CHECK (actor_source IN ('auth.uid', 'asserted_by_service_role', 'unknown')),

  -- The two facts the task-comment record carries that this table must not lose.
  reason text NOT NULL DEFAULT '',
  task_reference text NOT NULL DEFAULT '',

  changed_at timestamptz NOT NULL DEFAULT now(),

  -- The table's only invariant: a row that records no change is not a record.
  -- Enforced here as well as in the trigger's WHEN clause, so the invariant
  -- holds even if a future writer gets the trigger's condition wrong.
  CONSTRAINT story_byline_changes_records_a_change
    CHECK (old_byline_profile_id IS DISTINCT FROM new_byline_profile_id),

  -- Length caps raise rather than truncate, so an over-long value fails the
  -- whole byline change loudly instead of being silently shortened in an audit
  -- row. 22001 is string_data_right_truncation.
  CONSTRAINT story_byline_changes_reason_len
    CHECK (length(reason) <= 500),
  CONSTRAINT story_byline_changes_task_reference_len
    CHECK (length(task_reference) <= 120),
  CONSTRAINT story_byline_changes_byline_name_len
    CHECK (length(old_byline_name) <= 200 AND length(new_byline_name) <= 200),
  CONSTRAINT story_byline_changes_changed_by_name_len
    CHECK (length(changed_by_name) <= 200)
);

COMMENT ON TABLE public.story_byline_changes IS
  'Immutable attribution history for byline changes on stories. Written only by the trigger on stories.author_id, in the same transaction as the change. No foreign keys: the row must outlive the story and the profiles it names, and both profile ids are snapshots plus labels, not live references. No role may UPDATE, DELETE or INSERT here. Ruling: byline-authority, BEL-231, 2026-10-05.';

COMMENT ON COLUMN public.story_byline_changes.actor_source IS
  'How the actor was established: auth.uid (a signed-in PostgREST session), asserted_by_service_role (public.change_story_byline called with no auth.uid, so the caller named the actor), or unknown (no actor was available and none was guessed). Count the unknowns; that number is the size of the gap.';

COMMENT ON COLUMN public.story_byline_changes.story_slug IS
  'Snapshot of stories.slug at the moment of the change. The trail stays readable after the story row is deleted.';

-- ============================================================
-- 2. Indexes for the two questions this table exists to answer
-- ============================================================
-- "Every byline change to this story", which is the query the task-comment
-- record cannot answer with a SELECT.
CREATE INDEX IF NOT EXISTS idx_story_byline_changes_story
  ON public.story_byline_changes (story_id, changed_at DESC);

-- "Every byline change this week", named as weakness 1 of the prose record.
CREATE INDEX IF NOT EXISTS idx_story_byline_changes_changed_at
  ON public.story_byline_changes (changed_at DESC);

-- "Every byline change this profile made", for when a name is in question.
CREATE INDEX IF NOT EXISTS idx_story_byline_changes_actor
  ON public.story_byline_changes (changed_by_profile_id, changed_at DESC)
  WHERE changed_by_profile_id IS NOT NULL;

-- ============================================================
-- 3. Grants and RLS: one reader, no writer
-- ============================================================
ALTER TABLE public.story_byline_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.story_byline_changes FROM PUBLIC;
REVOKE ALL ON TABLE public.story_byline_changes FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.story_byline_changes TO authenticated, service_role;

-- The single policy, and it is SELECT-only. There is deliberately no INSERT,
-- UPDATE or DELETE policy on this table for any role, so the second lock holds
-- even if a grant is added later by hand.
DROP POLICY IF EXISTS "story_byline_changes_desk_read" ON public.story_byline_changes;
CREATE POLICY "story_byline_changes_desk_read"
  ON public.story_byline_changes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE public.profiles.id = auth.uid()
        AND public.profiles.role IN ('writer', 'admin')
    )
  );

-- anon gets no policy and no grant. The byline history of the newsroom is not
-- part of the public site.

-- The trigger function below is SECURITY DEFINER owned by the migration role,
-- so its INSERT succeeds as the owner and needs no grant for any caller. That
-- is the whole reason the table can have no INSERT grant and still be written.

-- ============================================================
-- 4. The writer: a trigger on stories.author_id
-- ============================================================
-- A trigger, because it is the only writer that cannot be bypassed by a path
-- nobody enumerated. There are two write paths into `stories` today - the edge
-- function as service_role, and the admin panel as authenticated over
-- PostgREST - and the branch has produced the same class of gap three times
-- from a path that was not in the list. A trigger sits inside the write, so
-- the list does not matter.
--
-- SECURITY DEFINER with a pinned search_path: it inserts as the owner, and an
-- unpinned SECURITY DEFINER function is search-path injectable.
CREATE OR REPLACE FUNCTION public.stories_log_byline_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_uid uuid := auth.uid();
  v_claimed uuid := nullif(current_setting('belmont.byline_actor', true), '')::uuid;
  v_actor uuid;
  v_actor_source text;
  v_reason text := coalesce(nullif(current_setting('belmont.byline_reason', true), ''), '');
  v_task_reference text := coalesce(nullif(current_setting('belmont.byline_task', true), ''), '');
BEGIN
  IF v_session_uid IS NOT NULL THEN
    -- A signed-in session is its own identity. It may say so in the GUC, and it
    -- may say nothing, but it may not name anyone else.
    v_actor := v_session_uid;
    v_actor_source := 'auth.uid';
    IF v_claimed IS NOT NULL AND v_claimed <> v_session_uid THEN
      RAISE EXCEPTION
        'a signed-in session cannot attribute a byline change to another profile'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF v_claimed IS NOT NULL THEN
    -- No auth.uid(): a service_role connection, which is the edge function's
    -- credential. It has already asserted the actor through
    -- public.change_story_byline(). This is self-asserted and the header says
    -- so; it is no weaker than the alternative, because that credential can
    -- already rewrite any row in the database.
    v_actor := v_claimed;
    v_actor_source := 'asserted_by_service_role';
  ELSE
    -- Nothing to read. Record the absence instead of inventing an actor.
    v_actor := NULL;
    v_actor_source := 'unknown';
  END IF;

  -- The byline names are snapshots of profiles.display_name taken now, so the
  -- row stays readable after a profile is renamed or removed. LEFT-JOIN
  -- semantics via coalesce: a profile id with no profiles row yields '' rather
  -- than dropping the audit row.
  INSERT INTO public.story_byline_changes (
    story_id, story_slug,
    old_byline_profile_id, old_byline_name,
    new_byline_profile_id, new_byline_name,
    changed_by_profile_id, changed_by_name, actor_source,
    reason, task_reference
  )
  VALUES (
    NEW.id, NEW.slug,
    OLD.author_id,
    coalesce((SELECT p.display_name FROM public.profiles p WHERE p.id = OLD.author_id), ''),
    NEW.author_id,
    coalesce((SELECT p.display_name FROM public.profiles p WHERE p.id = NEW.author_id), ''),
    v_actor,
    coalesce((SELECT p.display_name FROM public.profiles p WHERE p.id = v_actor), ''),
    v_actor_source,
    v_reason,
    v_task_reference
  );

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.stories_log_byline_change() IS
  'Writes the attribution row for a stories.author_id change. The only writer of story_byline_changes. SECURITY DEFINER because that table grants INSERT to nobody.';

-- AFTER, so the row recorded is the row that landed. AFTER also means the
-- trigger's failure aborts the UPDATE: a byline change that cannot be recorded
-- does not happen. That is the atomicity the prose record lacks.
--
-- `UPDATE OF author_id` narrows it to statements that name the column; the WHEN
-- clause drops the no-op case, so `SET author_id = author_id` writes nothing.
DROP TRIGGER IF EXISTS stories_log_byline_change ON public.stories;
CREATE TRIGGER stories_log_byline_change
  AFTER UPDATE OF author_id ON public.stories
  FOR EACH ROW
  WHEN (OLD.author_id IS DISTINCT FROM NEW.author_id)
  EXECUTE FUNCTION public.stories_log_byline_change();

-- ============================================================
-- 5. The one function a service_role caller needs
-- ============================================================
-- The edge function connects as service_role, which has no auth.uid(). Without
-- this function a byline change made through it is recorded with no actor and
-- `actor_source = 'unknown'`.
--
-- SECURITY INVOKER on purpose, and this is the load-bearing choice in the whole
-- file. A SECURITY DEFINER version would bypass `stories` RLS, which means any
-- signed-in reader could call rpc/change_story_byline and change any byline on
-- any story - the exact class of hole BEL-188 exists to close. As INVOKER, the
-- UPDATE inside is subject to `stories_writer_update` and a reader gets nothing.
--
-- SECURITY INVOKER is also why this cannot use PostgREST's connection pool
-- unsafely: `set_config(..., true)` is transaction-local and the UPDATE happens
-- in the same statement, so the trigger reads the value on the same connection
-- that set it. Two separate client calls would not be safe, which is why there
-- is no standalone "set the actor" function for a caller to use on its own.
--
-- The settings are cleared again before this function returns - see the comment
-- there, which explains why that is load-bearing.
CREATE OR REPLACE FUNCTION public.change_story_byline(
  p_story_id uuid,
  p_new_byline_profile_id uuid,
  p_actor_profile_id uuid DEFAULT NULL,
  p_reason text DEFAULT '',
  p_task_reference text DEFAULT ''
)
RETURNS public.stories
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_story public.stories;
  v_rows integer;
BEGIN
  IF length(coalesce(p_reason, '')) > 500 THEN
    RAISE EXCEPTION 'reason exceeds 500 characters'
      USING ERRCODE = 'string_data_right_truncation';
  END IF;
  IF length(coalesce(p_task_reference, '')) > 120 THEN
    RAISE EXCEPTION 'task_reference exceeds 120 characters'
      USING ERRCODE = 'string_data_right_truncation';
  END IF;

  -- A signed-in session may attribute to itself only.
  IF auth.uid() IS NOT NULL
     AND p_actor_profile_id IS NOT NULL
     AND p_actor_profile_id <> auth.uid() THEN
    RAISE EXCEPTION 'a signed-in session may only attribute a byline change to itself'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- An asserted actor must be a writer or an admin. A service_role connection
  -- has no auth.uid(), so this is the only check standing between that
  -- credential and a byline history full of invented names.
  IF p_actor_profile_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE public.profiles.id = p_actor_profile_id
         AND public.profiles.role IN ('writer', 'admin')
     ) THEN
    RAISE EXCEPTION 'attributed actor % is not a writer or an admin', p_actor_profile_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Set the attribution for this transaction BEFORE the UPDATE, because the
  -- trigger reads it during the UPDATE. Transaction-local, so it cannot leak
  -- onto the next request on a pooled connection.
  PERFORM set_config('belmont.byline_actor', coalesce(p_actor_profile_id::text, auth.uid()::text, ''), true);
  PERFORM set_config('belmont.byline_reason', coalesce(p_reason, ''), true);
  PERFORM set_config('belmont.byline_task', coalesce(p_task_reference, ''), true);

  UPDATE public.stories
     SET author_id = p_new_byline_profile_id,
         updated_at = now()
   WHERE id = p_story_id
  RETURNING * INTO v_story;

  -- Read the row count now, before anything else runs. `FOUND` is not safe
  -- here: `PERFORM` sets it to true, so the clear below would make a refused
  -- change - a story RLS filtered out, or one that does not exist - report
  -- success and hand back a null row to the caller. That is the silent-success
  -- failure this function exists to avoid, and it is why the count is taken
  -- from the UPDATE itself.
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Clear the attribution before returning. This is load-bearing, not tidiness.
  --
  -- `set_config(..., true)` is transaction-local, and this function is not. The
  -- setting outlives the function call and would otherwise still be set for the
  -- rest of the transaction, so a second byline change later in the same
  -- transaction would be recorded against the first one's actor, reason and task
  -- reference. On PostgREST each request is its own transaction and the leak is
  -- invisible; inside one transaction - a migration, a psql session, a test - it
  -- attributes a change to the wrong person, which is the one thing this table
  -- exists to prevent. The landing test asserts this exact case.
  --
  -- Clearing here rather than in the trigger is deliberate. A trigger that
  -- consumed the value would work for one row and mis-attribute every row after
  -- the first in a multi-row UPDATE. Every write to these settings goes through
  -- this function, so this is the only place that needs to clear them.
  --
  -- Nothing above this line can leave a stale setting behind: any RAISE happens
  -- before the settings are written, or after this clear, and a transaction-local
  -- setting is rolled back with the subtransaction that raised.
  PERFORM set_config('belmont.byline_actor', '', true);
  PERFORM set_config('belmont.byline_reason', '', true);
  PERFORM set_config('belmont.byline_task', '', true);

  IF v_rows = 0 THEN
    -- RLS filtered the row out, or there is no such story. Both are a refusal
    -- and neither should look like a silent success to the caller.
    RAISE EXCEPTION 'story % not found or not updatable by this session', p_story_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_story;
END
$$;

COMMENT ON FUNCTION public.change_story_byline(uuid, uuid, uuid, text, text) IS
  'Changes a story byline and records who did it, in one transaction. The only way a service_role caller (the edge function) gets an attributed byline change. SECURITY INVOKER: stories RLS still applies to the UPDATE inside.';

REVOKE ALL ON FUNCTION public.change_story_byline(uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_story_byline(uuid, uuid, uuid, text, text) TO authenticated, service_role;

-- anon does not get it: anon cannot update a story, and the function raises.

commit;

-- ============================================================
-- 6. Make PostgREST see it
-- ============================================================
-- The table, the policy and the function are all new PostgREST objects. A table
-- created by pasting SQL into the editor is not in the schema cache until the
-- cache is reloaded, and until it is, rpc/change_story_byline answers PGRST202
-- and a read of the table answers PGRST205. Delivered on COMMIT. Applying
-- through the Supabase CLI reloads the cache itself and this line does nothing.
NOTIFY pgrst, 'reload schema';
