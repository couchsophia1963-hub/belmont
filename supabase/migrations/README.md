# Migration version keys

Supabase keys `supabase_migrations` on the numeric filename prefix of
`<version>_<name>.sql`. The version is not a label. It is the ledger's primary
key, and it decides two things: whether a migration runs at all, and the order it
runs in.

## A reused version key is skipped, not refused

Two files on one version key in one push means one is applied and the other is
**dropped**. `db push` reports success. Nothing reports anything afterwards.

The migration's changes are absent from the database while the repository, the
pull request, and every review of it say they are present. The next person to hit
a missing column concludes the migration was never merged, and re-merges it. That
loop is the reason this file exists.

There is no failure message to grep for, because there is no failure. This is why
the check is a test rather than a review habit.

`supabase/migrations/versions.test.ts` fails a pull request that reuses a key, and
it runs in CI as part of `npm test`. It compares the branch against itself and
against `origin/main`. A key already recorded on `main` is the case it exists for:
that loss is permanent, because the key can never be applied again without
deleting the row.

It does **not** see a collision with a sibling open pull request; that needs the
GitHub API. The two rules below are what prevent that case.

## Rule 1: the version is a timestamp of authorship, not of merge

Take it once, when the migration is written. Do not regenerate it on rebase, on
review, or when a merge takes longer than expected.

Regenerating on rebase is what turns a collision into a moving target. On BEL-273
one migration went `20261005200000` → `20261005210000` → `20261005290000` in an
hour, because `main` took the first number and a concurrent run took the second.
Three migrations in this repository have now been renumbered for this reason.

If a key is already taken, the number is wrong, not the database. Change the
filename, and change every reference to it in the same commit — including
references inside other migrations and inside
`supabase/functions/api/index.ts`. Two of the `RAISE EXCEPTION` messages in
`20261005310000_api_keys_drop_key_hash.sql` name a version key an operator has to
go and look up, so a stale number in an error message is worse than no number.

Say so in the pull request. A reviewer who read the old number is reading a stale
anchor.

## Rule 2: reserve a key block per workstream, handed out in one place

Pick the block for the work, then take the next free key inside it. Do not pick
"now" and hope.

For the current merge window the whole in-flight set was reserved as one block:

| block | owner |
| --- | --- |
| `2026100529xxxx` | BEL-318: `5291` PR #34, `5292` PR #38, `5293` was PR #41's first choice |
| `2026100530xxxx`, `2026100531xxxx` | BEL-273: `5300` PR #42, `5310` PR #41 |

Per-workstream blocks are better than one shared block once there is more than one
stream in flight, because two authors in different workstreams then cannot collide
at all. A block is claimed in the issue that owns the work, not in each author's
head, and the claim is recorded in that issue.

**Before you take a key, check `main` *and* every open pull request.** Checking
`main` alone is what has failed repeatedly here: of the four version-key
collisions found on BEL-318, two were with `main` and two were with a sibling PR.

## What this file does not decide

Editing an already-applied migration in place is a different question, and it is
not a version-key collision. The same path, changed content, is legal as a diff
and unrecoverable in effect: the edit never reaches a database that already ran
the file. PR #27 does this deliberately and BEL-180 owns the question.

Renumbering is also the wrong fix when the duplicate is a stale copy of a
migration another pull request owns. Applying the stale copy under a fresh key and
then applying the newer revision under a second key is a double apply of the same
schema change. Delete the stale copy and depend on the owning pull request. That
is what happened to `20261005200000_api_keys_key_digest_and_revoked_at.sql` on
PR #42.