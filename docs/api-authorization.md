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

## Every mutating action

| Action | Function (`bcn_` key path) | PostgREST (RLS) | Trigger | Agree | Status |
| --- | --- | --- | --- | --- | --- |
| `stories.create` | writer (no test) | writer (`stories_writer_insert`) | -- | yes | settled |
| `stories.update` | writer (no test) | writer (`stories_writer_update`) | -- | yes | settled |
| `stories.delete` | admin + lock check | admin + lock check (`stories_admin_delete`) | -- | yes | settled |
| `stories.publish` | writer (no test) | writer (`stories_writer_update`) | -- | yes | settled |
| `stories.unpublish` | writer (no test) + lock check | writer (`stories_writer_update`) | -- | yes | settled |
| `stories.lock` | admin | writer (`stories_writer_update`) | stories_guard_lock_columns (locked) | **no** | MITIGATED, UNAPPLIED |
| `stories.unlock` | admin | writer (`stories_writer_update`) | stories_guard_lock_columns (locked), stories_guard_lock_columns (locked_until) | **no** | MITIGATED, UNAPPLIED |
| `weather.upsert` | writer (no test) | writer (`weather_writer_insert`) | -- | yes | settled |
| `weather.create` | writer (no test) | writer (`weather_writer_insert`) | -- | yes | settled |
| `weather.update` | writer (no test) | writer (`weather_writer_update`) | -- | yes | settled |
| `weather.delete` | admin | admin (`weather_admin_delete`) | -- | yes | settled |
| `rls.stories.insert` | -- | writer (`stories_writer_insert`) | -- | n/a | settled |
| `rls.stories.update` | -- | writer (`stories_writer_update`) | -- | n/a | settled |
| `rls.stories.delete` | -- | admin + lock check (`stories_admin_delete`) | -- | n/a | settled |
| `rls.weather_forecasts.insert` | -- | writer (`weather_writer_insert`) | -- | n/a | settled |
| `rls.weather_forecasts.update` | -- | writer (`weather_writer_update`) | -- | n/a | settled |
| `rls.weather_forecasts.delete` | -- | admin (`weather_admin_delete`) | -- | n/a | settled |
| `rls.profiles.update` | -- | owner (`profiles_owner_update`) | profiles_guard_role_update (role) | n/a | MITIGATED, UNAPPLIED |
| `rls.comments.insert` | -- | owner (`comments_user_insert`) | -- | n/a | settled |
| `rls.comments.update` | -- | owner (`comments_owner_update`) | -- | n/a | settled |
| `rls.comments.delete` | -- | owner_or_admin (`comments_owner_or_admin_delete`) | -- | n/a | settled |
| `rls.api_keys.insert` | -- | owner (`api_keys_owner_insert`) | -- | n/a | settled |
| `rls.api_keys.delete` | -- | owner (`api_keys_owner_delete`) | -- | n/a | settled |

## Notes per row

- **`stories.create`** — Any writer key. Matches stories_writer_insert, so the two surfaces agree.
- **`stories.update`** — No lock check, deliberately (BEL-83 item 2): a locked story must stay correctable.
  Editorial gate: api-of-record rule 2: a correction is update, never delete.
- **`stories.delete`** — Admin only, and refuses a locked story with 409. stories_admin_delete agrees on both.
  Editorial gate: api-of-record rule 5: delete is off limits without a board decision.
- **`stories.publish`** — Any writer key, on both surfaces. No role gate, and that is the ruling rather than an omission: rule 4 lives on the task, not in the database, so the backend cannot carry it, and a role test would only move the bypass to whoever holds the key. Settled, so a role gate added later fails this check until somebody updates the table deliberately.
  Editorial gate: api-of-record rule 4: publish requires an APPROVED QA verdict on the item's task.
- **`stories.unpublish`** — Any writer key, on both surfaces, and that is the contract. It is not quite unrestricted: it refuses a locked story with 409. Rule 3 is enforced by the newsroom and by nothing else, which the ruling records as intended. An admin gate would move the bypass to whoever holds the admin key rather than close it, and would make every takedown wait on one person while a wrong story stays live.
  Editorial gate: api-of-record rule 3: unpublish needs the editor's instruction, not an engineer's judgement.
- **`stories.lock`** — The function tests admin. PostgREST does not: stories_writer_update admits any writer for every column, so on its own a writer can PATCH locked=true through PostgREST. Migration 20261005200000 closes that in the repository with the trigger named above, which refuses a change to locked or locked_until from any caller that is not an admin. Not applied to the live database. Tracked on BEL-122, which the board confirmed as the canonical ticket for this hole; BEL-253 was closed as its duplicate. What a lock means is unchanged by the gap: it prevents deletion and unpublishing, and it is not a freeze -- a locked story stays correctable with update, deliberately.
  Editorial gate: api-of-record rule 3 names lock as well as unpublish: lock needs the editor's instruction. Rule 7: do not lock a story the editor may need to take down.
- **`stories.unlock`** — The function tests admin. Through PostgREST on its own, a writer could clear a lock an admin set, which also reopens the row to stories_admin_delete and to unpublish. Same gap as stories.lock and the more damaging half. The same 20261005200000 trigger refuses it: locked_until is in its column pair, so both halves are covered by one trigger. Not applied to the live database. Tracked on BEL-122.
- **`weather.upsert`** — One card per forecast_date. Matches weather_writer_insert.
- **`weather.create`** — Shares the upsert branch, `action === "upsert" || action === "create"`.
- **`weather.update`** — Matches weather_writer_update.
- **`weather.delete`** — Admin only, on both surfaces. Function guard at index.ts:337-341 (PR #9, d35e72a); RLS renamed weather_writer_delete to weather_admin_delete in 20261005170000 (PR #20, 63f543c). There is no lock or published equivalent to slow a writer down, which made it the least braked action in the function and the one this table was written for. BEL-235 reported it as ungated; it was gated on main already.
  Editorial gate: api-of-record rule 5: delete on either resource is off limits without an explicit board decision.
- **`rls.stories.insert`** — WITH CHECK admits writer and admin.
- **`rls.stories.update`** — Row-level and column-blind. This is the policy that makes the stories.lock and stories.unlock rows above real.
- **`rls.stories.delete`** — Admin and locked = false. Replaced by 20261005123424 to carry the lock clause.
- **`rls.weather_forecasts.insert`** — WITH CHECK admits writer and admin.
- **`rls.weather_forecasts.update`** — USING and WITH CHECK both admit writer and admin.
- **`rls.weather_forecasts.delete`** — Renamed from weather_writer_delete by 20261005170000. The old name would have been a lie after the change.
- **`rls.profiles.update`** — USING (auth.uid() = id) WITH CHECK (auth.uid() = id). RLS is row-level, so on its own this row does not constrain the role column, and an authenticated user who could write it could make themselves an admin -- the key to every role check in the function, because authenticate() reads this column. 20261005190000 adds the BEFORE UPDATE OF role trigger named above, which refuses a role change from any caller that is not service_role, a no-JWT session, or an existing admin. That closes it in the repository; the migration has not been applied to the live database, and that is the whole difference between this row and a settled one. Review by 2026-01-05: if it is still unapplied then, this row stays and the check keeps saying so.
- **`rls.comments.insert`** — WITH CHECK (auth.uid() = user_id). Cannot post as somebody else.
- **`rls.comments.update`** — Own comments only, both directions.
- **`rls.comments.delete`** — Owner or admin.
- **`rls.api_keys.insert`** — A user may mint a key for themselves, not for anyone else.
- **`rls.api_keys.delete`** — Revocation is the user's own to do.

## How to read a row

**Function rule** is the role test in the edge function, if there is one. `writer`
there means there is no `profile.role` test in the branch at all: the call is gated only
by `authenticate()` (`index.ts:61`), which admits any `bcn_` key whose profile is a
`writer` or an `admin`. `admin` means the branch tests `profile.role !== "admin"` and
returns 403.

**PostgREST rule** is what the live RLS policies admit for that table and command, with
the policy names. `owner` means the policy compares the row's owner column to
`auth.uid()`. `owner_or_admin` means either. `denied` means no policy covers that
command, so RLS refuses every row. `unknown` means more than one policy applies, or a
restrictive one, or the expression is not a rule this file recognises -- see below.

**Lock check** marks the actions that refuse to run against a locked story, either by
reading the `locked` column and returning 409, or by a `locked = false` clause in the
policy.

**Trigger** names a trigger that refuses a change to a named column. A trigger is not RLS:
it fires for every caller of the table, including the ones RLS has already admitted, and
RLS cannot see it. Only a trigger that raises an exception is a control, so this column
counts one only for a trigger whose function refuses.

A trigger declares the columns it guards in one of two ways, and the check reads both:

```
BEFORE UPDATE OF role ON profiles ...   -- the event clause names the column
BEFORE UPDATE ON stories ...            -- the event clause names none; the function
                                           refuses when NEW.locked differs from OLD.locked
```

Reading only the event clause reports the second shape as guarding nothing, which would
print a gap as unmitigated when the repository has closed it. A column counts as guarded
when the trigger refuses, and either the event clause lists it or the function compares
`NEW.<column>` against `OLD.<column>`.

**Status** is handled differently by the check for each value:

| status | meaning | on drift |
| --- | --- | --- |
| `settled` | both surfaces enforce this row | **fails** |
| `KNOWN GAP` | the surfaces genuinely disagree; recorded, understood, carried on a ticket | `INFO` |
| `MITIGATED, UNAPPLIED` | the repository closes the gap with a trigger, and the migration carrying it is not applied to the live database | `INFO` |
| `EDITORIAL` | settled in a human document, and the code is meant to carry no gate | `INFO` |

`publish` and `unpublish` are no longer `EDITORIAL`: BEL-258 answered them, and the answer is
"no role gate", so they are `settled` with an `editorialRef` pointing at the rule. A row that
has been decided is `settled`, and adding a role gate to either now fails the check until
somebody updates the table deliberately. No row carries `EDITORIAL` today; the status stays
in the vocabulary for a gate the newsroom has decided code must not carry.

Every status other than `settled` prints on every run, on both surfaces, and the reporting is
asserted against the spec rather than against the same list that gates it. An unrecognised
status string fails too: a typo matches no gate, so the row would be treated as settled and
never printed. A recorded gap that stops printing is worse than one that fails, because it
looks closed.

## What the check checks

```
npm run check:authz        # verify the code matches this table, and the doc matches too
npm run authz:doc          # regenerate docs/api-authorization.md from the spec
npm run check:authz --debug   # dump the parsed model: branches, policies, triggers, strays
```

1. Every `settled` row must match what the code does, on both surfaces.
2. A **mutating action in `index.ts` with no row is a failure.** Adding an action
   without saying who may call it stops being something a person has to notice.
3. A **row for something the code does not have is a failure**, in either direction, so
   the table cannot rot.
4. A new `CREATE POLICY ... FOR INSERT|UPDATE|DELETE` with no row is a failure.
5. **A command covered by more than one permissive policy is never `settled`.** Postgres
   OR-s every permissive policy for a command, so a broad `USING (true)` policy does not
   replace a narrow one, it widens it. Two policies resolve to `unknown` with the union
   printed, and a restrictive policy does too, because this file does not model the AND
   that restrictive policies compose into.
6. **An unrecognised role test is a failure.** `profile.role !== "subeditor"` is a
   narrower rule than any this file knows, and reporting it as the wider one is the same
   failure as reporting a false table as a passing one.
7. **A declared guard trigger has to be there.** A row asserting that a trigger refuses a
   change fails if that trigger is gone, on every status, because the row is asserting
   that a mitigation exists.
8. **Every non-settled row is reported, and the reporting is asserted against the spec.**
   The expectation is derived from `status !== "settled"`, not from the list that gates
   the reporting, because deriving both sides from one list makes the assertion
   circular: dropping a status from that list stops the report and shrinks the
   expectation in the same edit.
9. `docs/api-authorization.md` must match what the spec generates, so the table people
   read and the table the check enforces are the same table.

Two parser habits, both learned from a check that printed `PASS` while the table was wrong:

**SQL comments are blanked out before the migrations are parsed**, preserving offsets. These
migrations document themselves by quoting the DDL they replace --
`20261005190000_profiles_role_not_self_assignable.sql` opens with the text of
`profiles_owner_update` inside a block comment -- so a parser that does not skip comments
reads it as a second live policy, and then reports a row as unresolvable for the wrong
reason.

**Every gap between two SQL keywords is matched with `[\s\S]*?`, never `.*?`.** A dot does
not cross a newline, and this repository writes the same DDL both ways: `FOR EACH ROW
EXECUTE FUNCTION ...` on one line in `20261005190000`, split across two in `20261005200000`.
With `.*?` the second trigger is not found at all, and a guard the repository carries reads
as absent -- which is the false `PASS` one level down, because the rows that depend on the
guard stop being checked rather than starting to fail.

The check has no dependencies and needs no network, so it runs in a fresh checkout with
no install step.

## Coverage boundary

The table covers two things, and the check fails on a third:

- **Covered:** every mutating call inside an `if (resource === ...)` and
  `if (action === ...)` body in `index.ts`. Every such branch that mutates must have a
  row.
- **Covered, declared:** every mutating call outside those bodies. There is exactly one,
  `OUT_OF_BRANCH_WRITES` entry for `api_keys.last_used_at`, which `authenticate()`
  refreshes before it checks the caller's profile.
- **Fails:** any other mutating call anywhere in `index.ts`, because a write that no row
  claims is a write nobody has answered "who may do this" about.

A role test sitting *outside* a branch -- in `authenticate()`, for instance -- is read
and does not belong to any action row. That is the boundary, stated here rather than
assumed.

## Deploy ordering

Nothing in this change is a migration and nothing changes runtime behaviour, so there is
no database step, no frontend step and no ordering constraint to observe. Merging it
changes what the repository asserts about itself and nothing else.

The `MITIGATED, UNAPPLIED` status exists because that is the trap: a trigger in the
repository is a closed finding, and a trigger in the database is a control. Only the
second one is enforced.

If a future change to a `KNOWN GAP` row needs a migration, apply it before any function
deploy that depends on it, in the usual way. PostgREST rejects a write whose payload
names a column its schema cache has not seen, so a frontend that ships first breaks
admin saves while the homepage keeps rendering fine.

## What this file does not do

It does not restate the newsroom's editorial rules. `publish` and `unpublish` carry a
pointer to the `api-of-record` rules that govern them and nothing else, and their rows
are marked `settled` because the editorial answer is "no role gate" and the code agrees.
Decided on BEL-258: a role gate would move the bypass to whoever holds the key rather
than close it, and would make every takedown wait on one person while a wrong story stays
live. That is a newsroom decision, recorded there, and this file only holds up its end
of it.

It does not apply migrations. `rls.profiles.update` is closed in the repository and open in
the database, and no amount of reading text changes that.
