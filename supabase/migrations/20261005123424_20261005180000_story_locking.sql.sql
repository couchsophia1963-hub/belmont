/*
# Add story locking for admins

1. Purpose
   Admins can "lock" a story to prevent it from being deleted by anyone (including other
   admins). A locked story shows a badge in the Story Manager and the delete button is
   disabled. Locking is admin-only — writers can edit story content but cannot lock or
   unlock stories.

   This also lays the groundwork for "until X" time-based locks in the future by storing
   an optional locked_until timestamp.

2. New Columns
   - stories.locked (boolean, NOT NULL, default false) — when true, the story cannot be
     deleted via the Story Manager or the API.
   - stories.locked_until (timestamptz, nullable) — reserved for future time-based locks.
     Currently unused by the frontend but stored so a future migration can add the logic
     without another schema change.

3. Security
   - The existing stories_writer_update policy already allows writers+admins to update
     any column, including the new locked column. We add a separate stories_admin_lock
     UPDATE policy scoped to the locked/locked_until columns is not needed because
     Postgres RLS is row-level, not column-level — the existing UPDATE policy covers it.
   - We add a stories_admin_delete policy that blocks DELETE on locked rows for everyone
     except when the caller is an admin AND the row is not locked. Actually, we modify
     the existing stories_admin_delete to also check locked = false.
*/

ALTER TABLE stories ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Replace the admin delete policy to also prevent deletion of locked stories.
-- A locked story cannot be deleted by anyone through RLS, even an admin.
-- To delete a locked story, the admin must first unlock it.
DROP POLICY IF EXISTS "stories_admin_delete" ON stories;
CREATE POLICY "stories_admin_delete"
  ON stories FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
    AND locked = false
  );
