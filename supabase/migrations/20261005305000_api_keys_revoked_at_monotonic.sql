-- api_keys: revoked_at is write-once, or the audit trail is the subject's to edit (BEL-273, PR #43)

-- Refs BEL-273, BEL-282, PR #42, PR #44
--
-- WHY THIS FILE EXISTS
--
-- PR #42 adds `api_keys_owner_update`, so an owner can UPDATE their own api_keys row.
-- RLS constrains WHO, never WHAT: PostgreSQL policies cannot restrict columns, and there
-- is no column-level RLS. So the moment that policy lands, the owner of a row can write
-- `revoked_at` on that row -- including setting it back to NULL.
--
-- That matters because `revoked_at` is the field the whole revoke-instead-of-delete change
-- is built on. PR #40's section 8 gives the case this file exists to keep honest: a key
-- revoked on the 5th whose `last_used_at` is the 9th was still being called after it was
-- meant to be gone. That comparison is evidence only if `revoked_at` cannot afterwards be
-- rewritten by the person the evidence is about.
--
-- Without this file the trail reads as evidence while being editable by its own subject,
-- which is worse than having no trail: an operator reviewing it cannot tell a genuine
-- revoke from an un-revoke.
--
-- A policy expression cannot express this. Policy context has no OLD row -- only USING
-- (which rows are visible) and WITH CHECK (what a new row may become), and neither can
-- see the previous value. So it takes a row trigger.
--
-- The alternative considered and rejected: move the panel's revoked_at writes to the edge
-- function and run them under service_role. That works, but it moves traffic, splits the
-- write path across two runtimes, and leaves direct PostgREST writes from the browser
-- still able to un-revoke -- the policy is what makes those writes possible, so the hole
-- stays open for anyone who finds it. One trigger closes it for every writer, present and
-- future, including curl.
--
-- Ordering. Requires 20261005290000 (PR #40), which adds the column, and is intended to
-- land with 20261005300000 (PR #42), which creates the policy this closes the hole in.
-- It must land before the panel change that revokes keys (PR C). Independent of PR #24.
--
-- The edge function is unaffected. It authenticates and stamps last_used_at through
-- SUPABASE_SERVICE_ROLE_KEY, and that write does not touch revoked_at, so this trigger
-- fires, finds the column unchanged, and returns NEW. Verified below by construction:
-- NEW.revoked_at IS DISTINCT FROM OLD.revoked_at is false when the column is not in the
-- statement.
--
-- No grant is added, widened, or narrowed. No policy is added or changed.
--
-- Not applied. No agent on this beat can reach Belmont News's database (BEL-48). This is
-- reviewed text, and no claim is made about what it does to a real table.

-- ============================================================
-- SECTION 1. Prerequisite.
--
-- Refuses rather than half-applying. A trigger whose column does not exist would create
-- cleanly and then fail on the first revoke, which is the "migration applied, panel
-- broken" shape this repository keeps paying for. Same rule PR #40 section 6 states for
-- its own grants, and the same reason the census blocks in PR #40 and PR #41 raise
-- instead of warning.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_keys'
      AND column_name = 'revoked_at'
  ) THEN
    RAISE EXCEPTION
      'api_keys.revoked_at does not exist, so nothing in this file has run. Apply '
      '20261005290000 (PR #40) first, then re-apply this file.';
  END IF;
END
$$;

-- ============================================================
-- SECTION 2. The trigger function
--
-- Write-once, in one direction: NULL may become a timestamp (that is a revoke), and once
-- it is set it may not move. Refusing any change to a non-NULL revoked_at also refuses
-- back-dating it to a moment before the key actually stopped working, which is the
-- subtler half of the same problem -- a forged date is as good as no date.
--
-- The comparison is NEW vs OLD rather than a check for NULL. `IS DISTINCT FROM` is used
-- so a no-op write that happens to name the column is still permitted: setting
-- revoked_at to the value it already holds is not tampering, and refusing it would make
-- the panel's idempotent re-revoke fail for no reason.
--
-- search_path is pinned. The body references only OLD/NEW and raises; there is no
-- unqualified identifier to resolve, so this is belt-and-braces rather than a fix for a
-- defect, and it means the function cannot be made to resolve anything unexpected if it
-- is ever edited.
-- ============================================================
CREATE OR REPLACE FUNCTION public.api_keys_revoked_at_is_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'api_keys.revoked_at is write-once. This key was already revoked at %, and an audit '
      'field that its own subject can move is not evidence of anything. Revoking is '
      'permanent: issue a new key instead.', OLD.revoked_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.api_keys_revoked_at_is_monotonic() IS
  'Refuses any UPDATE that changes a non-NULL api_keys.revoked_at, including clearing it or back-dating it. Makes the revoke timestamp tamper-evident for direct PostgREST writes as well as the panel. Policy context has no OLD row, so this cannot be expressed as a policy. Un-revoking a key revoked in error is an operator task that needs a migration.';

-- ============================================================
-- SECTION 3. The trigger
--
-- BEFORE UPDATE, not BEFORE UPDATE OF revoked_at.
--
-- UPDATE OF fires only when the column appears in the statement's SET list, which is
-- cheaper, and it is the wrong choice here for the reason BEL-24's review gave for the
-- stories trigger: trigger firing order for UPDATE OF is by name among BEFORE triggers,
-- so any other BEFORE trigger on this table that altered NEW.revoked_at would do so
-- without this one being consulted. api_keys_fill_key_digest does not touch revoked_at
-- today, so there is no hole at the moment -- but "there is no hole today" is exactly the
-- condition under which a cheaper trigger looks safe and then stops being.
--
-- The cost of the safe choice is one NULL comparison per api_keys UPDATE, on a table
-- whose update rate is a handful of calls per key per day.
--
-- Dropped before created, so a replay does not abort with "trigger already exists".
-- Every CREATE TRIGGER in this repository is preceded by its drop: see PR #27 and
-- PR #40 section 9. Without that, the second `db push` fails.
-- ============================================================
DROP TRIGGER IF EXISTS api_keys_revoked_at_monotonic ON public.api_keys;

CREATE TRIGGER api_keys_revoked_at_monotonic
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.api_keys_revoked_at_is_monotonic();

-- ============================================================
-- SECTION 4. Post-check
--
-- Reads the trigger back rather than trusting this file's own success message. Checks
-- that it exists, that it is BEFORE and FOR EACH ROW, and that it covers UPDATE of the
-- whole row rather than a column list -- the last is the one that would silently stop
-- covering a write path added later.
-- ============================================================
DO $$
DECLARE
  trig_def text;
  trig_type integer;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);

  SELECT t.tgtype::integer, pg_get_triggerdef(t.oid)
    INTO trig_type, trig_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.api_keys'::regclass
     AND t.tgname = 'api_keys_revoked_at_monotonic'
     AND NOT t.tgisinternal;

  IF trig_def IS NULL THEN
    RAISE EXCEPTION 'api_keys_revoked_at_monotonic is absent after this migration ran.';
  END IF;

  -- pg_trigger.tgtype bits, from src/include/catalog/pg_trigger.h:
  --   1 = ROW (row-level, not per-statement)   2 = BEFORE      4 = INSERT
  --   8 = DELETE   16 = UPDATE   32 = TRUNCATE   64 = INSTEAD OF
  -- The four that make this trigger correct: ROW and BEFORE set, UPDATE set, INSTEAD OF
  -- clear. Each condition below raises when the bit is NOT what it must be.
  IF (trig_type & 1) = 0 THEN
    RAISE EXCEPTION
      'api_keys_revoked_at_monotonic is statement-level, not FOR EACH ROW. It reads: %', trig_def;
  END IF;

  IF (trig_type & 2) = 0 THEN
    RAISE EXCEPTION
      'api_keys_revoked_at_monotonic is not a BEFORE trigger. An AFTER trigger would let the '
      'write land first. It reads: %', trig_def;
  END IF;

  IF (trig_type & 64) <> 0 THEN
    RAISE EXCEPTION
      'api_keys_revoked_at_monotonic is INSTEAD OF. It reads: %', trig_def;
  END IF;

  IF (trig_type & 16) = 0 THEN
    RAISE EXCEPTION
      'api_keys_revoked_at_monotonic does not fire on UPDATE. It reads: %', trig_def;
  END IF;

  IF trig_def LIKE '%UPDATE OF%' THEN
    RAISE EXCEPTION
      'api_keys_revoked_at_monotonic is scoped to a column list (UPDATE OF). It must cover '
      'the whole row, or a later write path that reaches revoked_at indirectly is not '
      'checked. It reads: %', trig_def;
  END IF;

  IF trig_def NOT LIKE '%api_keys_revoked_at_is_monotonic%' THEN
    RAISE EXCEPTION 'api_keys_revoked_at_monotonic runs the wrong function. It reads: %', trig_def;
  END IF;

  RAISE NOTICE 'api_keys: revoked_at is now write-once. tgtype = %, trigger: %', trig_type, trig_def;
END
$$;

-- PostgREST never reads triggers and this file adds no table, column, function callable
-- over RPC, or policy -- so there is no schema-cache reason to reload here, and NOTIFY
-- pgrst would be a no-op. The reload in 20261005300000 belongs to that file because that
-- one adds a policy the panel needs to be told about. This trigger changes behaviour
-- through Postgres, on the next statement, with no cache in between.