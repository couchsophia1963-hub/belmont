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