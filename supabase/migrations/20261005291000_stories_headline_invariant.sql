/*
# stories: the database refuses a second headline, and one function swaps it

1. Purpose
   "Exactly one story is the headline" is what `HomePage.tsx:29-35` depends on. It
   reads the headline with `.maybeSingle()`, which **errors** on more than one row,
   and `HomePage.tsx:44` turns any error into a full-page error state. So a second
   headline does not degrade the front page, it removes it.

   Nothing stopped that second headline. `idx_stories_headline`, added in
   `20261004123918_create_belmont_news_schema.sql:252`, is a plain partial index:

       CREATE INDEX IF NOT EXISTS idx_stories_headline ON stories (is_headline) WHERE is_headline = true;

   An index is for finding rows. It does not refuse writes. The invariant was held
   entirely by two sequential requests from `StoryManagerPage`, and the first one's
   result was discarded (BEL-233). A dropped request, a timeout, a PostgREST 500, or
   a row filtered out by an RLS `USING` clause was enough.

   This file puts the invariant in the database: a unique partial index, and a
   function that does the swap in one transaction.

2. Why a unique index, and why it is partial
   `WHERE is_headline = true` on a boolean column means the index only holds the
   rows that claim to be the headline, and uniqueness applies to that set alone.
   Every such row stores the same value (`true`), so at most one row can exist. The
   predicate is identical to the existing index, so this is the same query the
   homepage runs, now with a guarantee attached.

   The old index is dropped rather than kept alongside. Same predicate, same column:
   a second index over the same rows costs write time and buys nothing, and leaving
   both would be two indexes with different names and identical meaning.

3. Why the swap is a function and not two statements
   A PostgREST request is one transaction, but two requests are two transactions,
   and the gap between them is where zero headlines live: a browser closing there
   leaves the page with no lead story, silently, because `.maybeSingle()` returns
   `null` for zero rows without an error. `plpgsql` gives both updates one
   transaction, so either both land or neither does. The unique index is the backstop
   for the case two clients call this at the same instant.

4. SECURITY INVOKER, on purpose
   This function is called from the browser as `authenticated`, where
   `stories_writer_update` is the gate. INVOKER keeps that gate: a reader, or an
   authenticated user with no `writer`/`admin` profile row, updates nothing and gets
   nothing.

   SECURITY DEFINER would be the wrong default here. It would bypass RLS for the
   two UPDATEs and leave the function as the only thing authorising the swap, which
   is the shape that produced the weather-delete and lock defects earlier in this
   repository: a rule that lives in one function and nowhere else. INVOKER means
   this change adds no new way to write `stories`, and the existing policies stay the
   single answer to "who may write a story".

   The exception is `service_role`, which bypasses RLS either way, and which is what
   `supabase/functions/api/index.ts` uses. That function can still write
   `is_headline` directly (`index.ts:163`) and will now get a `23505` instead of
   silently making two headlines. Correcting it is a function deploy, not a migration.

5. Grants: nothing is widened, and read before applying
   This file grants EXECUTE on the new function to `authenticated`, and revokes it
   from `PUBLIC` and from `anon`. That is the whole of it. No table privilege changes,
   so no existing grant can be narrowed by accident.

   Still run this first, per the standing rule about column-scoped grants. The two
   UPDATEs inside the function need UPDATE on `is_headline`, and the `RAISE
   EXCEPTION` path below is the reason the function refuses a row it cannot see.
   Count columns, not rows:

      select
        (select count(*) from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = 'stories')
          as total_columns,
        (select count(distinct p.column_name)
           from information_schema.column_privileges p
          where p.table_schema = 'public' and p.table_name = 'stories'
            and p.grantee = 'authenticated' and p.privilege_type = 'UPDATE')
          as updatable_columns;

   Expected: `updatable_columns = total_columns`. That is the Supabase table-level
   default, granted through default privileges, and `authenticated` already holds
   UPDATE on every column, `is_headline` included. Across this repository the only
   GRANT or REVOKE so far is on `public.comments_public`
   (`20261005160000_comments_public_view.sql:102-103`), so that is what is expected.

   Do NOT test this by asking whether `information_schema.column_privileges`
   returns rows. It always does: a table-level GRANT is reported there too,
   expanded one row per column, and the table owner appears with its implicit
   privileges whether or not anything was ever granted. An empty result means
   something is wrong with the query, not that the grants are narrow. This section
   used to read "if it returns no rows ... if it returns rows, stop", which is the
   inversion BEL-329 records, and it is also the copy
   `20261005123424_20261005180000_story_locking.sql` section 5 inherited from the
   standing rule in README.md. `20261005190000_profiles_role_not_self_assignable.sql`
   section 4 is the corrected form of this query, learned against a real
   PostgreSQL 18.

   If `updatable_columns` comes back lower than `total_columns`, a column-scoped
   grant has to be extended to `is_headline` in this same change, or every write
   the function makes fails afterwards while the function itself exists. STOP and
   escalate with the output; do not widen a grant to make this file apply.

6. The repair, and the one judgement call in this file
   A unique index cannot be created while duplicates exist, so this has to handle
   them. If the table already holds two headlines, this demotes all but one and
   announces every row it touched:

       pick = the headline with the newest created_at, ties broken by id

   That is a guess, and it is the only guess in this file. If duplicates exist right
   now, the right answer is which story the newsroom wants as the lead, and that is
   not something to infer from a timestamp. **Say which story it is and this rule
   changes before anyone applies the file** — nothing here is applied yet, so the
   question is free. If it returns no rows the block does nothing at all.

   Getting it wrong is not catastrophic: the demoted story can be promoted again
   from the Story Manager in one click, and BEL-233's client guard (#33) makes that
   panel report what it actually did.

   The repair does not touch `updated_at`. Demoting is not an editorial change to the
   story, and re-running the file picks the same row, so it is idempotent.

7. Ordering
   **Database first.** The frontend that calls `set_story_headline` must not be
   deployed until this file is applied, or the call 404s against PostgREST's schema
   cache and the Story Manager stops swapping headlines at all.

   #33, the client guard, does **not** call this function and does not depend on this
   file in any way. It can be deployed in either order, before or after. Nothing else
   is blocked on this file.

8. Apply it once. Merge deploys nothing.
   Applying this file is a separate step from merging it. It needs a `service_role`
   key, a Management API token, or a reachable Postgres port; none is available to me
   (BEL-233). Do not treat this PR as applied.
*/

begin;

-- ============================================================
-- 1. REPAIR: at most one headline before the index can exist
-- ============================================================
do $$
declare
  v_pick uuid;
  v_id uuid;
  v_slug text;
  v_hits integer;
begin
  select count(*) into v_hits from public.stories where is_headline;

  if v_hits > 1 then
    select id into v_pick
      from public.stories
     where is_headline
     order by created_at desc, id desc
     limit 1;

    raise notice 'stories: % headlines exist. Keeping % and demoting the rest.',
      v_hits, v_pick;

    for v_id, v_slug in
      select id, slug from public.stories
       where is_headline and id is distinct from v_pick
    loop
      raise notice 'stories: demoting headline % (%)', v_slug, v_id;
    end loop;

    update public.stories
       set is_headline = false
     where is_headline
       and id is distinct from v_pick;
  end if;
end;
$$;

-- ============================================================
-- 2. THE INVARIANT: a unique partial index on is_headline
-- ============================================================
drop index if exists public.idx_stories_headline;

create unique index if not exists idx_stories_headline_unique
  on public.stories (is_headline)
  where is_headline = true;

-- ============================================================
-- 3. THE SWAP: one function, one transaction
-- ============================================================
create or replace function public.set_story_headline(p_story_id uuid, p_is_headline boolean)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_is_headline then
    update public.stories
       set is_headline = false
     where is_headline
       and id is distinct from p_story_id;
  end if;

  update public.stories
     set is_headline = p_is_headline
   where id = p_story_id;

  if not found then
    raise exception 'set_story_headline: no story with id %', p_story_id
      using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.set_story_headline(uuid, boolean) from public;
revoke all on function public.set_story_headline(uuid, boolean) from anon;
grant execute on function public.set_story_headline(uuid, boolean) to authenticated;

commit;

-- ============================================================
-- Verify after applying. Expect exactly one headline.
--
--   select count(*) as headlines from public.stories where is_headline;
--
-- Expect 0 or 1. If it is more than 1 the repair did not run, and the unique index
-- would have refused to be created, so a file that applied cleanly means this is 0
-- or 1 by construction.
--
-- The index is unique on the headline rows:
--
--   select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'stories'
--      and indexname like '%headline%';
--
-- Expect one row, `idx_stories_headline_unique`, with `CREATE UNIQUE INDEX`.
--
-- The function refuses a second headline. Run this as a writer with a real session;
-- it must fail with 23505, and the table must still hold one headline:
--
--   select public.set_story_headline(<a published story id>, true);
--   select public.set_story_headline(<a different published story id>, true);  -- 23505
--   select count(*) from public.stories where is_headline;                    -- 1
--
-- `anon` cannot call it, which is the point of the REVOKE:
--
--   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
--     "$SUPABASE_URL/rest/v1/rpc/set_story_headline" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
--     -d '{"p_story_id":"00000000-0000-0000-0000-000000000000","p_is_headline":true}'
--
-- Expect 401 or 403.
--
-- The homepage still reads. `stories_public_read` is untouched by this file:
--
--   curl -s "$SUPABASE_URL/rest/v1/stories?select=id,slug&is_headline=eq.true&published=eq.true"
--
-- Expect one object.