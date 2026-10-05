# Branch rules for `main`

`main-required-review.json` is a GitHub ruleset for `couchsophia1963-hub/belmont`.
It is a file, not something this repository applies to itself. Applying it needs
admin on the repository, and no account with admin is available to the agents
that write here. See "Who can apply this" below.

## What it enforces

| Rule | Setting | Why |
| --- | --- | --- |
| `pull_request` | `required_approving_review_count: 1` | One approval from a GitHub identity that is not the author. |
| `pull_request` | `require_last_push_approval: true` | The approval has to postdate the final push, so it covers the code that actually merges. |
| `pull_request` | `dismiss_stale_reviews_on_push: true` | An approval given against an earlier diff is discarded when the diff changes. |
| `pull_request` | `require_code_owner_review: true` | The approver must be the owner named in `.github/CODEOWNERS`, which is `dustinwloring1988`. |
| `pull_request` | `required_review_thread_resolution: true` | An unresolved review conversation blocks the merge, so a reviewer cannot be silenced by resolving their own thread. |
| `required_status_checks` | `typecheck, lint, test, build`, `integration_id: 15368` | The `CI` workflow from PR #22, which reports as advisory until it is named here. |
| `required_status_checks` | `strict_required_status_checks_policy: true` | A green run against a stale base does not count. |
| `non_fast_forward` | — | Force-pushes to `main` are rejected. |
| `bypass_actors` | `[]` | Nobody merges past this, including an admin. |

`integration_id: 15368` is the GitHub Actions app. Pinning it means a status
posted by anyone or anything else cannot satisfy the check.

## Who can apply this

Not the agents, and not the board operator. Measured on 2026-10-05:

| Account | `belmont` | `belmont-news-site` | `belmont-news-blogs` |
| --- | --- | --- | --- |
| `EasySchedule` (this repo's writer) | write | **admin** | **admin** |
| `dustinwloring1988` (board operator) | write | read | read |
| `couchsophia1963-hub` (org owner) | **admin** | — | — |

Rulesets are a repository-admin object. `PUT /repos/{owner}/{repo}/rulesets` from
either of the first two rows returns `403 Resource not accessible by integration`.
The only account that can apply this file is `couchsophia1963-hub`.

## Apply order

The order is load-bearing. Each step depends on the one before it existing.

1. **Merge this pull request**, authored by `EasySchedule`, merged by
   `dustinwloring1988`. `.github/CODEOWNERS` has to be on `main` before
   `require_code_owner_review: true` can match anything; a ruleset that requires a
   code owner review when no code owner is defined blocks all pull requests
   including the one adding it. This merge is also the first time in this
   repository's history that the merger is not the author.
2. **Apply the ruleset**, as `couchsophia1963-hub`:

   ```sh
   gh api -X PUT repos/couchsophia1963-hub/belmont/rulesets \
     -H 'Accept: application/vnd.github+json' \
     --input .github/rulesets/main-required-review.json
   ```

   A ruleset does not exist in the repository until this call runs. Committing
   the file records intent; it enforces nothing.
3. **Read the ruleset back** and confirm every field in the table above
   survived the write:

   ```sh
   gh api repos/couchsophia1963-hub/belmont/rulesets --jq '.[] | {id, name, enforcement}'
   gh api repos/couchsophia1963-hub/belmont/rulesets/<id>
   ```

   This step is not optional ceremony. `PUT` returns `200` on a payload that
   drops a parameter, so a successful write is not evidence that the rule is
   the rule that was asked for.
4. **Rebase or re-run CI on the pull requests that have no check run.** Measured
   2026-10-05T17:45Z: 15 pull requests open, 8 mergeable and 7 conflicting, and
   **12 of the 15 have no `CI` run at all**, because `ci.yml` only began running
   when PR #22 merged at 17:37:22Z. Under `strict_required_status_checks_policy`
   those 12 cannot merge until they build against the current `main`.
5. **Approve the queue.** Each open pull request needs its own approval from
   `dustinwloring1988`. Turning this rule on does not release the queue; it
   converts 15 self-merges into 15 human approvals.

## Two consequences worth knowing before step 2

**Local merges stop working.** With `dismiss_stale_reviews_on_push` or
`require_last_push_approval` set, GitHub rejects a merge commit built by hand and
pushed straight to a protected branch, unless its contents match the merge GitHub
would have generated. Merge through the pull request (`gh pr merge`), not with
`git merge` plus `git push`. A merge also invalidates approvals when the merge
base moves, so the pull request right behind a merged one needs re-approval.

**One login carries the whole gate.** `.github/CODEOWNERS` names a single person.
If that person is unavailable, `main` stops. That is the correct behaviour when
there is no second pair of eyes, and it is also the first thing to revisit if it
becomes a throughput problem.

## Provenance of the payload

The JSON in this directory was accepted by GitHub's ruleset validator on
2026-10-05 and then read back field by field: all five `pull_request` booleans
and all three `required_status_checks` settings were stored as sent. It was
validated on `EasySchedule/belmont-news-site` — the one repository whose admin is
available — as a scratch ruleset with `enforcement: "disabled"` pointed at a ref
that does not exist, so it could not gate anything, and it was then deleted.
Ruleset `24397951` on that repository was compared before and after and is
byte-identical, `updated_at` still `2026-10-05T16:13:37.992Z`.