/*
# Allow writers and admins to see all stories (including unpublished)

1. Purpose
   The original stories_public_read SELECT policy only returns published=true rows.
   This means writers and admins cannot see their own drafts in the Story Manager.
   This migration adds a second SELECT policy that lets writers and admins see ALL
   stories regardless of published status, while keeping the public read limited to
   published stories only.

2. Security changes
   - New policy "stories_writer_select_all" on stories FOR SELECT TO authenticated
     that allows writers/admins to read all rows.
   - Existing "stories_public_read" policy is kept unchanged: anon and authenticated
     users can still only see published=true stories. The two policies are OR'd by
     Postgres, so a writer sees (published=true) OR (is writer/admin) = all rows,
     while a regular user sees only published=true.
*/

DROP POLICY IF EXISTS "stories_writer_select_all" ON stories;
CREATE POLICY "stories_writer_select_all"
  ON stories FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  );
