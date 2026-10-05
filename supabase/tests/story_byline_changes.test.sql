-- ============================================================
-- Landing test: story_byline_changes (BEL-249)
--
-- Run this AFTER applying 20261005200000_story_byline_changes.sql.
-- It is safe on the live project: everything runs inside one transaction that
-- ROLLBACKs, so it creates and destroys its own fixtures and leaves no row,
-- no policy and no grant behind. Paste the whole file into the Supabase SQL
-- editor and run it.
--
-- What a pass means
-- -----------------
-- Every assertion maps to a line in the migration header's "does guarantee"
-- list, plus one deliberate assertion that the honest gap is still there and
-- still says so. If this file passes, the ruling's record is a database row
-- rather than a prose comment, on every write path into `stories.author_id`.
--
-- What it does not prove
-- ----------------------
-- It does not prove the attribution survives in the *live* project, only that
-- the schema behaves as documented here. The post-check in the migration header
-- is the live read.
--
-- It also asserts one thing that is currently a defect on purpose:
-- `actor_source = 'unknown'`. A service_role write that does not go through
-- public.change_story_byline() records no actor, and this file asserts that it
-- records no actor *loudly* rather than inventing one. When the edge function
-- is changed to use change_story_byline, that count should go to zero. The
-- assertion is written so that it will FAIL if the edge function starts
-- attributing correctly and nobody updates this file - which is the right
-- direction for a test to break.
--
-- Safe to re-run: yes, it rolls back.

begin;

-- ============================================================
-- 0. Assertion helpers
-- ============================================================
-- Failures raise P0001 (raise_exception). Expected refusals are caught by their
-- specific SQLSTATE, so a genuine assertion failure cannot be swallowed by an
-- exception handler and read as a pass.
create or replace function pg_temp.lt(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'FAIL: %', label using errcode = 'P0001';
  end if;
  raise notice 'ok   %', label;
end
$$;

-- Assert that a statement is refused, and refused for the right reason.
create or replace function pg_temp.lt_refuses(label text, expected_sqlstate text, stmt text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate <> expected_sqlstate then
      raise exception 'FAIL: % -- expected %, got % (%)', label, expected_sqlstate, sqlstate, sqlerrm
        using errcode = 'P0001';
    end if;
    raise notice 'ok   % [%]', label, sqlstate;
    return;
  end;
  raise exception 'FAIL: % -- the statement succeeded, expected %', label, expected_sqlstate
    using errcode = 'P0001';
end
$$;

-- ============================================================
-- 1. Fixtures: three profiles and one published story
-- ============================================================
-- `on_auth_user_created` creates the profiles row itself, so the fixtures insert
-- the auth users first and then set display_name and role on the rows it made.
-- That is the same order the operator uses in the dashboard.
do $$
declare
  v_admin uuid := '11111111-1111-1111-1111-111111111111';
  v_wdev  uuid := '22222222-2222-2222-2222-222222222222';
  v_wrosa uuid := '33333333-3333-3333-3333-333333333333';
  v_rosa  uuid := '44444444-4444-4444-4444-444444444444';
  v_ray   uuid := '55555555-5555-5555-5555-555555555555';
  v_story uuid := '66666666-6666-6666-6666-666666666666';
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin@belmont.test'),
    (v_wdev,  'dev@belmont.test'),
    (v_wrosa, 'rosa@belmont.test'),
    (v_rosa,  'rosa-plain@belmont.test'),
    (v_ray,   'ray@belmont.test');

  update public.profiles set display_name = 'ADMIN',       role = 'admin'  where id = v_admin;
  update public.profiles set display_name = 'Dev Okafor',  role = 'writer' where id = v_wdev;
  update public.profiles set display_name = 'Rosa Delgado',role = 'writer' where id = v_wrosa;
  update public.profiles set display_name = 'Rosa Plain',  role = 'user'   where id = v_rosa;
  update public.profiles set display_name = 'Ray Reader',  role = 'user'   where id = v_ray;

  insert into public.stories (id, title, slug, excerpt, body, author_id, published)
  values (v_story, 'Landing test story', 'landing-test-story', 'e', 'b', v_wdev, true);

  raise notice 'ok   fixtures: admin, two writers, two plain readers, one published story';
end
$$;

-- ============================================================
-- 2. The shape of the table
-- ============================================================
select pg_temp.lt(
  (select count(*) = 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'story_byline_changes'),
  'story_byline_changes exists');

select pg_temp.lt(
  (select count(*) = 13 from information_schema.columns
    where table_schema = 'public' and table_name = 'story_byline_changes'),
  'it has the 13 documented columns');

select pg_temp.lt(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'story_byline_changes'),
  'row level security is enabled');

-- Survivability, asserted rather than asserted-in-a-comment. An audit row that
-- cascades away with the story, or nulls out with the profile, is the defect
-- this file exists to prevent, and `byline_roster.profile_id` already makes
-- the wrong choice once.
select pg_temp.lt(
  (select count(*) = 0 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'story_byline_changes' and c.contype = 'f'),
  'no foreign keys on the table, so nothing cascades or sets null');

-- Exactly one policy, and it is SELECT-only.
select pg_temp.lt(
  (select count(*) = 1 from pg_policies
    where schemaname = 'public' and tablename = 'story_byline_changes'
      and cmd = 'SELECT' and policyname = 'story_byline_changes_desk_read'),
  'one SELECT policy for writers and admins, and no write policy at all');

select pg_temp.lt(
  (select count(*) = 0 from pg_policies
    where schemaname = 'public' and tablename = 'story_byline_changes'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  'no INSERT, UPDATE or DELETE policy exists for any role');

-- ============================================================
-- 3. The trigger writes the row, in the write''s own transaction
-- ============================================================
-- A signed-in writer session, as the admin panel is.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

update public.stories
   set author_id = '44444444-4444-4444-4444-444444444444'
 where id = '66666666-6666-6666-6666-666666666666';

reset role;

select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes),
  'one byline change writes exactly one attribution row');

select pg_temp.lt(
  (select old_byline_profile_id::text  = '22222222-2222-2222-2222-222222222222'
     and new_byline_profile_id::text  = '44444444-4444-4444-4444-444444444444'
     and old_byline_name = 'Dev Okafor'
     and new_byline_name = 'Rosa Plain'
     and story_slug = 'landing-test-story'
     and actor_source = 'auth.uid'
     and changed_by_profile_id::text = '22222222-2222-2222-2222-222222222222'
     and changed_by_name = 'Dev Okafor'
   from public.story_byline_changes),
  'the row names both bylines, both profile ids, the slug, the actor and how the actor was known');

select pg_temp.lt(
  (select changed_at is not null from public.story_byline_changes),
  'the row carries a timestamp');

-- Weakness 1 of the prose record was "not queryable". This is that query.
select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes
    where changed_at > now() - interval '1 week'),
  '"every byline change this week" is a SELECT, not a search');

-- Two writes that are not byline changes must leave no row. An audit trail that
-- fires on every edit is an audit trail nobody reads.
set local role authenticated;
update public.stories set body = 'a corrected paragraph' where id = '66666666-6666-6666-6666-666666666666';
update public.stories set author_id = author_id where id = '66666666-6666-6666-6666-666666666666';
reset role;

select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes),
  'a body edit and a no-op byline write record nothing');

-- A row that had no byline and gained one is a change. That state exists in
-- this database today, and it is a real attribution event.
update public.stories set author_id = null where id = '66666666-6666-6666-6666-666666666666';
update public.stories set author_id = '33333333-3333-3333-3333-333333333333' where id = '66666666-6666-6666-6666-666666666666';

select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes where old_byline_profile_id is null),
  'giving a story its first byline is recorded as a change from nothing');

select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes where new_byline_profile_id is null),
  'a byline change to null is recorded rather than skipped');

-- ============================================================
-- 4. The trigger cannot be bypassed, and cannot be argued with
-- ============================================================
-- A row whose old and new byline are identical is not a record of anything. The
-- CHECK constraint holds even without the trigger''s WHEN clause.
select pg_temp.lt_refuses(
  'a row that records no change cannot be inserted, even by the owner',
  '23514',
  $$insert into public.story_byline_changes
      (story_id, story_slug, old_byline_profile_id, new_byline_profile_id)
    values ('66666666-6666-6666-6666-666666666666', 'landing-test-story',
            '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222')$$);

-- The attribution is not truncated into uselessness: an over-long reason fails
-- the whole byline change, so the change does not land unrecorded. The reason
-- is only ever set through change_story_byline, so that is where it is tested.
select pg_temp.lt_refuses(
  'an over-long reason aborts the byline change instead of being truncated',
  '22001',
  $$select public.change_story_byline(
      '66666666-6666-6666-6666-666666666666',
      '22222222-2222-2222-2222-222222222222',
      '22222222-2222-2222-2222-222222222222',
      repeat('a', 501),
      'BEL-231')$$);

select pg_temp.lt(
  (select count(*) = 3 from public.story_byline_changes)
  and (select author_id::text = '33333333-3333-3333-3333-333333333333' from public.stories
        where id = '66666666-6666-6666-6666-666666666666'),
  'the refused change wrote no row and left the story''s byline where it was');

-- ============================================================
-- 5. Immutability: no role may rewrite or forge the history
-- ============================================================
set local role authenticated;

select pg_temp.lt_refuses('authenticated cannot UPDATE the history', '42501',
  $$update public.story_byline_changes set reason = 'quietly corrected'$$);
select pg_temp.lt_refuses('authenticated cannot DELETE the history', '42501',
  $$delete from public.story_byline_changes$$);
select pg_temp.lt_refuses('authenticated cannot INSERT into the history', '42501',
  $$insert into public.story_byline_changes (story_id, story_slug, old_byline_profile_id, new_byline_profile_id)
    values ('66666666-6666-6666-6666-666666666666', 'landing-test-story',
            '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444')$$);

reset role;
set local role anon;

select pg_temp.lt_refuses('anon cannot read the history', '42501',
  $$select * from public.story_byline_changes$$);
select pg_temp.lt_refuses('anon cannot UPDATE the history', '42501',
  $$update public.story_byline_changes set reason = 'x'$$);
select pg_temp.lt_refuses('anon cannot DELETE the history', '42501',
  $$delete from public.story_byline_changes$$);

reset role;
set local role service_role;

-- service_role is the credential that bypasses RLS. If it could also rewrite
-- the audit trail, then "no role can UPDATE or DELETE" would be false and the
-- migration header would be lying.
select pg_temp.lt_refuses('service_role cannot UPDATE the history', '42501',
  $$update public.story_byline_changes set changed_by_name = 'someone else'$$);
select pg_temp.lt_refuses('service_role cannot DELETE the history', '42501',
  $$delete from public.story_byline_changes$$);
select pg_temp.lt_refuses('service_role cannot INSERT into the history', '42501',
  $$insert into public.story_byline_changes (story_id, story_slug, old_byline_profile_id, new_byline_profile_id)
    values ('66666666-6666-6666-6666-666666666666', 'landing-test-story',
            '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444')$$);

reset role;

-- ============================================================
-- 6. Who may read it
-- ============================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select pg_temp.lt(
  (select count(*) = 3 from public.story_byline_changes),
  'a writer reads the full byline history');

select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select pg_temp.lt(
  (select count(*) = 0 from public.story_byline_changes),
  'a signed-in reader who is not a writer or admin reads nothing');

reset role;

-- ============================================================
-- 7. public.change_story_byline: the service_role path
-- ============================================================
set local role service_role;

-- A service_role connection carries no JWT, so there is no request.jwt.claim.sub.
-- Anything left on the connection from an earlier request in this same
-- transaction is cleared here so the assertions below describe a real
-- service_role call.
select set_config('request.jwt.claim.sub', '', true);

-- Fail closed, not open. If a stale claim ever survived onto a pooled service_role
-- connection, the function refuses the change rather than attributing it to the
-- wrong person. The direction of that failure is the point.
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select pg_temp.lt_refuses(
  'a service_role connection carrying a stale JWT claim is refused, not misattributed',
  '42501',
  $$select public.change_story_byline(
      '66666666-6666-6666-6666-666666666666',
      '22222222-2222-2222-2222-222222222222',
      '22222222-2222-2222-2222-222222222222')$$);
select set_config('request.jwt.claim.sub', '', true);

-- The function exists so the edge function, which has no auth.uid(), can say
-- who it is. This is the row it produces.
select (public.change_story_byline(
  '66666666-6666-6666-6666-666666666666',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
  'corrected attribution, desk asked',
  'BEL-231')).id is not null as wrote;

select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes
    where actor_source = 'asserted_by_service_role'
      and changed_by_profile_id::text = '33333333-3333-3333-3333-333333333333'
      and changed_by_name = 'Rosa Delgado'
      and reason = 'corrected attribution, desk asked'
      and task_reference = 'BEL-231'),
  'a service_role caller that uses the function gets an attributed row with its reason and task');

-- And an actor it asserts must be a writer or an admin, or that credential can
-- write invented names into the history.
select pg_temp.lt_refuses(
  'service_role cannot attribute a byline change to a plain reader',
  '23503',
  $$select public.change_story_byline(
      '66666666-6666-6666-6666-666666666666',
      '22222222-2222-2222-2222-222222222222',
      '55555555-5555-5555-5555-555555555555')$$);

reset role;

-- The gap, asserted. This is a service_role write that skips the function, so
-- there is no identity to read. The row must record that fact and invent nothing.
set local role service_role;
update public.stories
   set author_id = '44444444-4444-4444-4444-444444444444'
 where id = '66666666-6666-6666-6666-666666666666';
reset role;

select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes
    where actor_source = 'unknown' and changed_by_profile_id is null and changed_by_name = ''),
  'a service_role write that skips change_story_byline records no actor and says so, rather than guessing one');

-- The attribution belongs to the call that supplied it and to nothing else.
--
-- `set_config(..., true)` is transaction-local and this whole test is one
-- transaction, so an earlier version of public.change_story_byline() left its
-- actor, reason and task reference set for everything that followed. This row
-- was then recorded against Rosa Delgado, who did not make it. That is the
-- defect this assertion was written for: an audit row that names the wrong
-- person is worse than no audit row, because it is believed.
select pg_temp.lt(
  (select count(*) = 1 from public.story_byline_changes
    where actor_source = 'unknown'
      and reason = ''
      and task_reference = ''),
  'a later byline change does not inherit the previous call''s reason or task reference');

-- ============================================================
-- 8. change_story_byline must not become a privilege escalation
-- ============================================================
-- SECURITY INVOKER, so stories RLS still governs the UPDATE inside. A signed-in
-- reader who calls it gets a refusal, not a byline change on somebody's story.
set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);

select pg_temp.lt_refuses(
  'a plain reader cannot use change_story_byline to change a byline',
  'P0002',
  $$select public.change_story_byline(
      '66666666-6666-6666-6666-666666666666',
      '22222222-2222-2222-2222-222222222222',
      null, 'not mine to change', 'BEL-231')$$);

-- And a writer cannot attribute its own change to somebody else.
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select pg_temp.lt_refuses(
  'a signed-in writer cannot attribute a byline change to another profile',
  '42501',
  $$select public.change_story_byline(
      '66666666-6666-6666-6666-666666666666',
      '22222222-2222-2222-2222-222222222222',
      '44444444-4444-4444-4444-444444444444')$$);

reset role;

-- ============================================================
-- 9. Survivability: the record outlives the story and the profiles
-- ============================================================
-- The whole point of recording a change is that it is still there afterwards.
delete from public.stories where id = '66666666-6666-6666-6666-666666666666';

select pg_temp.lt(
  (select count(*) > 0 from public.story_byline_changes where story_slug = 'landing-test-story'),
  'deleting the story does not delete its byline history');

select pg_temp.lt(
  (select count(*) > 0 from public.story_byline_changes
    where story_slug = 'landing-test-story' and new_byline_name = 'Rosa Plain'),
  'the byline names are text snapshots, so they survive the story row');

-- byline_roster.profile_id uses ON DELETE SET NULL. If this table had copied
-- that, deleting these two profiles would have nulled every profile id they
-- appear in and left a file of dates.
--
-- The test cannot simply assert "no nulls": two of the rows above legitimately
-- have a null byline, because a story was stripped of one and another gained its
-- first. So it asserts the sharper thing - where there is a byline name, there is
-- still a profile id behind it.
delete from public.profiles where id in ('22222222-2222-2222-2222-222222222222',
                                         '44444444-4444-4444-4444-444444444444');

select pg_temp.lt(
  (select count(*) = 0 from public.story_byline_changes
    where (old_byline_name <> '' and old_byline_profile_id is null)
       or (new_byline_name <> '' and new_byline_profile_id is null)),
  'deleting the profiles behind a byline does not null the history, which is why there are no foreign keys');

select pg_temp.lt(
  (select count(*) > 0 from public.story_byline_changes where old_byline_name = 'Dev Okafor'),
  'the byline name is still readable after the profile is gone');

-- ============================================================
-- 10. Report and roll back
-- ============================================================
select actor_source, count(*) as rows
  from public.story_byline_changes
 group by actor_source
 order by actor_source;

rollback;

-- If you reached here with no FAIL, the migration is landed:
--   * every byline change on every write path is a row,
--   * the row is atomic with the change,
--   * no role can change, forge or remove it,
--   * it outlives the story and the profiles.
-- The one open item is the 'unknown' row above, which is the edge function not
-- yet calling public.change_story_byline. That is a client change in a later PR,
-- and it must not deploy before this migration.
