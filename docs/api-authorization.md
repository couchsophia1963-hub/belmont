# Who is allowed to do what

**The table below is generated.** Do not edit it by hand. The source of truth is
`scripts/api-authorization-spec.mjs`; regenerate with `npm run authz:doc` and verify
with `npm run check:authz`.

Added on [BEL-235](/BEL/issues/BEL-235). That ticket arrived as "the `weather delete`
branch has no role check" and turned out to be a missing table rather than a missing
guard. This is the table, and `scripts/check-api-authorization.mjs` is the check that
keeps the code honest against it.

## The short answer

The newsroom had three answers to one question, which is two more than it should
have had:

| | today |
| --- | --- |
| `delete`, either resource | **admin only**, on both surfaces |
| `lock`, `unlock` | **admin only** in the function, **any writer** through PostgREST |
| `publish`, `unpublish` | **any writer**, on both surfaces |
| `create`, `update`, `upsert` | **any writer**, on both surfaces |

Delete is admin-only everywhere. Everything else a writer is meant to touch is
writer-accessible on both surfaces, with one exception that is recorded below as a
known gap rather than papered over.

Two findings came out of writing this table. Both are on the PostgREST surface, both
need SQL that is not reachable from here, and neither is fixed in this change:

1. **`profiles.role` is writable by its own subject.** `profiles_owner_update` is
   `USING (auth.uid() = id) WITH CHECK (auth.uid() = id)`, and Postgres RLS is
   row-level, so it constrains *which row* and not *which column*. Any
   `authenticated` user — not even a writer — can PATCH their own row with
   `{"role":"admin"}`. The admin role dropdown in `DashboardPage.tsx` is gated in
   React, and React is not a control. This is the most serious thing in this file:
   the function's `authenticate()` reads `profiles.role`, so escalating there
   escalates everywhere the function authorises.
2. **`stories.locked` is writable by any writer.** `stories_writer_update` admits
   `writer` and `admin` for every column, so a writer can clear a lock that an admin
   set. The locking migration reasons about row-level versus column-level RLS and
   stops there; the conclusion it should have reached is that a column-scoped control
   needs a column grant or a trigger, and neither of those is expressible in RLS.

BEL-251 covers the first and is the more serious of the two. BEL-253 covers the second. Neither is
a new decision and neither is fixed here: both need SQL, and there is no route to a database from
this repository. Both rows are marked `KNOWN GAP` in the table below, so `npm run check:authz` prints
them on every run and reports again the day either one closes.

## Every mutating action

| Action | Function (`bcn_` key path) | PostgREST (RLS) | Agree | Status |
| --- | --- | --- | --- | --- |
| `stories.create` | writer (no test) | writer (`stories_writer_insert`) | yes | settled |
| `stories.update` | writer (no test) | writer (`stories_writer_update`) | yes | settled |
| `stories.delete` | admin + lock check | admin + lock check (`stories_admin_delete`) | yes | settled |
| `stories.publish` | writer (no test) | writer (`stories_writer_update`) | yes | EDITORIAL |
| `stories.unpublish` | writer (no test) + lock check | writer (`stories_writer_update`) | yes | EDITORIAL |
| `stories.lock` | admin | writer (`stories_writer_update`) | **no** | KNOWN GAP |
| `stories.unlock` | admin | writer (`stories_writer_update`) | **no** | KNOWN GAP |
| `weather.upsert` | writer (no test) | writer (`weather_writer_insert`) | yes | settled |
| `weather.create` | writer (no test) | writer (`weather_writer_insert`) | yes | settled |
| `weather.update` | writer (no test) | writer (`weather_writer_update`) | yes | settled |
| `weather.delete` | admin | admin (`weather_admin_delete`) | yes | settled |
| `rls.stories.insert` | -- | writer (`stories_writer_insert`) | n/a | settled |
| `rls.stories.update` | -- | writer (`stories_writer_update`) | n/a | settled |
| `rls.stories.delete` | -- | admin + lock check (`stories_admin_delete`) | n/a | settled |
| `rls.weather_forecasts.insert` | -- | writer (`weather_writer_insert`) | n/a | settled |
| `rls.weather_forecasts.update` | -- | writer (`weather_writer_update`) | n/a | settled |
| `rls.weather_forecasts.delete` | -- | admin (`weather_admin_delete`) | n/a | settled |
| `rls.profiles.update` | -- | owner (`profiles_owner_update`) | n/a | KNOWN GAP |
| `rls.comments.insert` | -- | owner (`comments_user_insert`) | n/a | settled |
| `rls.comments.update` | -- | owner (`comments_owner_update`) | n/a | settled |
| `rls.comments.delete` | -- | owner_or_admin (`comments_owner_or_admin_delete`) | n/a | settled |
| `rls.api_keys.insert` | -- | owner (`api_keys_owner_insert`) | n/a | settled |
| `rls.api_keys.delete` | -- | owner (`api_keys_owner_delete`) | n/a | settled |

## Notes per row

- **`stories.create`** — Any writer key. Matches stories_writer_insert, so the two surfaces agree.
- **`stories.update`** — No lock check, deliberately (BEL-83 item 2): a locked story must stay correctable.
  Editorial gate: api-of-record rule 2: a correction is update, never delete.
- **`stories.delete`** — Admin only, and refuses a locked story with 409. stories_admin_delete agrees on both.
  Editorial gate: api-of-record rule 5: delete is off limits without a board decision.
- **`stories.publish`** — No role restriction on either surface. The QA gate is a human process and the code does not carry it.
  Editorial gate: api-of-record rule 4: publish needs an APPROVED QA verdict on the task.
- **`stories.unpublish`** — Writer-accessible on both surfaces. Refuses a locked story (409). Whether the role gate should exist is BEL-156's question and is not settled here.
  Editorial gate: api-of-record rule 3: unpublish needs the editor's instruction, not an engineer's judgement.
- **`stories.lock`** — The function tests admin. PostgREST does not: stories_writer_update admits any writer for every column, so a writer can PATCH locked=true on the function's own terms. Tracked on BEL-253.
- **`stories.unlock`** — The function tests admin. Through PostgREST a writer can clear a lock an admin set, which also reopens the row to stories_admin_delete and to unpublish. Same gap as stories.lock, and the more damaging half. Tracked on BEL-253.
- **`weather.upsert`** — One card per forecast_date. Matches weather_writer_insert.
- **`weather.create`** — Shares the upsert branch, `action === "upsert" || action === "create"`.
- **`weather.update`** — Matches weather_writer_update.
- **`weather.delete`** — The subject of BEL-235. Function guard at index.ts:337-341 (PR #9, d35e72a), RLS renamed weather_writer_delete to weather_admin_delete in 20261005170000 (PR #20, 63f543c). Both surfaces admin-only. There is no lock or published equivalent, so this was the least braked action in the function.
- **`rls.stories.insert`** — WITH CHECK admits writer and admin.
- **`rls.stories.update`** — Row-level and column-blind. This is the policy that makes the stories.lock and stories.unlock rows above real.
- **`rls.stories.delete`** — Admin and locked = false. Replaced by 20261005123424 to carry the lock clause.
- **`rls.weather_forecasts.insert`** — WITH CHECK admits writer and admin.
- **`rls.weather_forecasts.update`** — USING and WITH CHECK both admit writer and admin.
- **`rls.weather_forecasts.delete`** — Renamed from weather_writer_delete by 20261005170000. The old name would have been a lie after the change.
- **`rls.profiles.update`** — USING (auth.uid() = id) WITH CHECK (auth.uid() = id). Row-level, so the role column is not constrained: any authenticated user can set their own role to admin. Any authenticated user can therefore make themselves an admin, which is the key to every role check in the edge function, because authenticate() reads this column. Tracked on BEL-251, which outranks this row.
- **`rls.comments.insert`** — WITH CHECK (auth.uid() = user_id). Cannot post as somebody else.
- **`rls.comments.update`** — Own comments only, both directions.
- **`rls.comments.delete`** — Owner or admin.
- **`rls.api_keys.insert`** — A user may mint a key for themselves, not for anyone else.
- **`rls.api_keys.delete`** — Revocation is the user's own to do.

## How to read a row

**Function rule** is the role test in the edge function, if there is one. `writer`
there means there is no `profile.role` test in the branch at all: the call is gated
only by `authenticate()` (`index.ts:61`), which admits any `bcn_` key whose profile is
a `writer` or an `admin`. `admin` means the branch tests `profile.role !== "admin"`
and returns 403.

**PostgREST rule** is the effective rule from the live RLS policy, with the policy
name. `owner` means the policy compares the row's owner column to `auth.uid()`.
`owner_or_admin` means either. `denied` means no policy covers that command for that
table, so RLS refuses every row.

**Lock check** marks the actions that refuse to run against a locked story, either by
reading the `locked` column and returning 409, or by a `locked = false` clause in the
policy.

**Status** is one of three values and each one is handled differently by the check:
`settled` is asserted and fails on drift, `KNOWN GAP` is a recorded disagreement
between the two surfaces, and `EDITORIAL` is settled in a human document rather than in
code. The last two are reported on every run and never fail the build, because a
check that is red forever is a check nobody reads.

## What the check actually checks

```
npm run check:authz        # verify the code matches this table, and the doc matches too
npm run authz:doc          # regenerate docs/api-authorization.md from the spec
```

1. Every `settled` row must match what the code does, on both surfaces. Drift fails.
2. Every `KNOWN GAP` and `EDITORIAL` row must still be in the state recorded here. A
   change is reported as `INFO`, because it means the gap closed or the editorial
   answer moved, and the table needs a human to look at it.
3. A mutating action in `index.ts` with no row here is a **failure**. This is the check
   that matters: adding an action without saying who may call it stops being a thing
   that has to be noticed.
4. A row here for an action that no longer exists in `index.ts` is a **failure**, so
   removing an action has to remove its row and the table cannot rot.
5. The same applies to RLS: a new `CREATE POLICY ... FOR INSERT|UPDATE|DELETE` without
   a row is a failure.
6. `docs/api-authorization.md` must match what the spec generates. The table people
   read and the table the check enforces are the same table.

The check has no dependencies and needs no network. It parses
`supabase/functions/api/index.ts` and `supabase/migrations/*.sql` as text, so it runs
in a fresh checkout with no install step.

## Deploy ordering

Nothing in this change is a migration and nothing changes runtime behaviour, so there
is no database step, no frontend step and no ordering constraint to observe. Merging
it changes what the repository asserts about itself and nothing else.

If a future change to a `KNOWN GAP` row needs a migration, it must be applied before
any function deploy that depends on it, in the usual way. PostgREST rejects a write
whose payload names a column the schema cache has not seen, so a frontend that ships
first breaks admin saves while the homepage keeps rendering fine.

## What this file deliberately does not do

It does not decide who may publish or unpublish. That is settled in BEL-61's
`api-of-record`, rules 3 and 4, and the two `EDITORIAL` rows point at those rules
rather than paraphrasing them into an engineering decision.

It does not fix the two findings above. Both need SQL, there is no route to a database
from here, and a column grant has to be read before it is touched. They are filed.
