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