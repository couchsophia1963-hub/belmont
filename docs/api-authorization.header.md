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
It does have one, and it had since `d35e72a`. The part of that ticket worth doing was
the rest of it: the function authorised per action, the answers did not agree, and each
disagreement had been found separately by somebody reading one action. That is a method
that finds one action per pass and only the ones somebody happened to look at. So the
answers are written down here, and `scripts/check-api-authorization.mjs` fails when the
code stops matching them.

## The short answer

| | who | agreed on both surfaces? |
| --- | --- | --- |
| `delete`, either resource | **admin only** | yes |
| `lock`, `unlock` | **admin only** in the function, **any writer** through PostgREST | no |
| `publish`, `unpublish` | **any writer** | yes |
| `create`, `update`, `upsert` | **any writer** | yes |

Delete is admin-only everywhere. Everything else a writer is meant to touch is
writer-accessible on both surfaces.

The one row where the two surfaces disagree is `lock`/`unlock`, and it is not left as a
narrative: the table marks it, the check prints it on every run, and a trigger in the
repository closes it without being applied to the database. See the open items below. That
phrase is about the two surfaces only. Where a column is the subject, neither surface can
express the rule at all, which is what the trigger column is for.

## Two surfaces, and a third one that is neither

The edge function's client is built with `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS
entirely, so on that path the only gate is an `if` statement in TypeScript. PostgREST
runs as `authenticated`, where RLS is the only gate and the TypeScript is never
involved. **Neither is a backstop for the other**, which is why every row names both.

A trigger is a third surface. It is neither a policy nor a line of TypeScript: it fires
for every caller of the table, including the ones RLS has already admitted, and RLS
cannot see it. Only a trigger that refuses is a control, so this file counts one only
when the function it calls raises an exception.

## Open items: three rows the repository has closed and the database has not

All three have the same shape, and the shape is the point. RLS is row-level, so no policy
can say "any column of this row except this one". Three findings are each a column a
subject should not be able to write, and none of them is expressible in RLS at all. Each is
closed in the repository by a trigger that refuses, and none is applied. **Merging is not
applying**, and a table that cannot tell those two apart lies by omission, so these rows
say so and `npm run check:authz` prints them on every run.

| row | column | policy on its own | trigger in the repository | migration |
| --- | --- | --- | --- | --- |
| `stories.lock`, `stories.unlock` | `stories.locked`, `stories.locked_until` | `stories_writer_update` admits any writer for every column | `stories_guard_lock_columns` | `20261005200000` |
| `rls.profiles.update` | `profiles.role` | `profiles_owner_update` is `USING (auth.uid() = id) WITH CHECK (auth.uid() = id)`, so on its own it does not constrain the column | `profiles_guard_role_update` | `20261005190000` |

`profiles.role` is the more serious of the two classes. `authenticate()` reads that column,
so it is the key to every role check in the edge function; one self-assignment there
escalates everywhere the function authorises. Its migration refuses a role change from any
caller that is not `service_role`, a no-JWT session, or an existing admin.

`stories.locked` matters because `stories_admin_delete` is `USING (admin AND locked =
false)`, and that clause is the only thing between an admin and a deliberately frozen
story. The migration guarding it also refuses a non-admin moving `published` from true to
false while the story is locked, so the lock cannot be stepped around by taking the story
offline instead. Tracked on BEL-122, which the board confirmed as the canonical ticket for
this hole.

Two findings produced these rows and both were closed as duplicates of existing tickets, so
the canonical numbers here are theirs: BEL-251 was closed against BEL-224, and BEL-253
against BEL-122. The rows follow the surviving tickets rather than the duplicates.

What a lock means is unchanged by any of this. It prevents deletion and unpublishing. It is
not a freeze: a locked story stays correctable with `update`, deliberately.