# Who is allowed to do what

**The table below is generated. Do not edit it by hand.** The source of truth is
`scripts/api-authorization-spec.mjs`; regenerate with `npm run authz:doc` and verify
with `npm run check:authz`.

This file holds **code facts only**: which enforcement surface lets which subject
change which row. The newsroom's own rules -- who may publish, who may unpublish,
what must be approved first -- live in the `api-of-record` contract document and are
not restated here. That contract names this file and `npm run check:authz` as the
mechanical authority for its role column, so where the two disagree, this file is the
one that has to be right.

Added on BEL-235, which reported that the `weather delete` branch has no role check.
It does have one, at `index.ts:337-341`, and it had since `d35e72a`. The part of that
ticket worth doing was the rest of it: the function authorised per action, the answers
did not agree, and each disagreement had been found separately by somebody reading one
action. That is a method that finds one action per pass and only the ones somebody
happened to look at. So the answers are written down here, and
`scripts/check-api-authorization.mjs` fails when the code stops matching them.

## The short answer

| | who |
| --- | --- |
| `delete`, either resource | **admin only**, both surfaces |
| `lock`, `unlock` | **admin only** in the function, **any writer** through PostgREST |
| `publish`, `unpublish` | **any writer**, both surfaces |
| `create`, `update`, `upsert` | **any writer**, both surfaces |

Delete is admin-only everywhere. Everything else a writer is meant to touch is
writer-accessible on both surfaces, with one exception recorded below as a known gap
rather than papered over.

## Two surfaces, and a third one that is neither

The edge function's client is built with `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS
entirely, so on that path the only gate is an `if` statement in TypeScript. PostgREST
runs as `authenticated`, where RLS is the only gate and the TypeScript is never
involved. **Neither is a backstop for the other**, which is why every row names both.

A trigger is a third surface. It is neither a policy nor a line of TypeScript: it fires
for every caller of the table, including the ones RLS has already admitted, and RLS
cannot see it. Only a trigger that refuses is a control, so this file counts one only
when the function it calls raises an exception.

## Open items

**`stories.locked` and `stories.locked_until` are writable by any writer.** Known gap,
rows `stories.lock` and `stories.unlock`. `stories_writer_update` admits writers and
admins for every column, so a writer can clear a lock that an admin set --
`stories_admin_delete` is `USING (admin AND locked = false)`, and that clause is the
only thing between an admin and a deliberately frozen story. Tracked as BEL-253.

The migration that introduced story locking reasons about this at
`20261005123424_..._story_locking.sql.sql:21-25`: because Postgres RLS is row-level, it
argues, the `locked` columns need no special handling. The premise is right and the
conclusion does not follow from it. Row-level means a policy *cannot* express "not the
`locked` column", which is not the same as the column being covered. A column-scoped
control needs a column grant or a trigger.

**`profiles.role` is writable by its own subject, and the repository now closes it.**
Row `rls.profiles.update`, status *mitigated, unapplied*. `profiles_owner_update` is
`USING (auth.uid() = id) WITH CHECK (auth.uid() = id)`, and RLS is row-level, so on its
own it does not constrain the `role` column. That matters more than a profile field:
`authenticate()` reads that column, so it is the key to every role check in the
function. Migration `20261005190000` adds a `BEFORE UPDATE OF role` trigger that refuses
a role change from any caller that is not `service_role`, a no-JWT session, or an
existing admin.

That migration is in the repository and **has not been applied to the live database**,
which is the whole difference between this row and a settled one. Merging is not
applying, and a table that cannot tell the two apart is a table that lies by omission.