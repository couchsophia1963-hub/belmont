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