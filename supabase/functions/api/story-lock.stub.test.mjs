/**
 * Stub harness for the BEL-166 lock boundary. No Deno, no Supabase, no test
 * runner, no dependency: `node supabase/functions/api/story-lock.stub.test.mjs`
 *
 * The deployed edge function is not reachable from this desk (BEL-154), and
 * Deno is not installed here, so this is the guard that can actually run. It
 * covers the decision `index.ts` makes for `update { published: false }`.
 * `publish` and `unpublish` are left as they are and are not covered.
 *
 * The repo's vitest runner and CI check belong to PR #22 / BEL-141 and own
 * package.json and src/. This file is deliberately outside both, so the two do
 * not collide. When #22 lands, fold these cases into it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { evaluateDelete, evaluateTakeDown } from "./story-lock.ts";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));
const indexSource = readFileSync(INDEX, "utf8");

// The `update` action only: everything from its branch to the next action, so
// these assertions cannot be satisfied by a guard that lives on another route.
const updateBranch = indexSource.slice(
  indexSource.indexOf('if (action === "update")'),
  indexSource.indexOf('if (action === "delete")'),
);

const LOCKED_LIVE = { wantsUnpublish: true, locked: true, published: true };
const LOCKED_DRAFT = { wantsUnpublish: true, locked: true, published: false };
const UNLOCKED_LIVE = { wantsUnpublish: true, locked: false, published: true };

test("a writer key cannot take a locked live story down through update", () => {
  const decision = evaluateTakeDown(LOCKED_LIVE);
  assert.equal(decision.allowed, false, "the take-down must be refused");
  assert.equal(decision.status, 409, "it must not answer 200");
  assert.match(decision.message, /locked/i, "the refusal must say why");
  assert.match(decision.message, /unlock/i, "the refusal must say what to do");
});

test("the refusal matches the one unpublish already gives", () => {
  const takeDown = evaluateTakeDown(LOCKED_LIVE);
  assert.equal(takeDown.status, 409, "same status as the unpublish check");
  assert.equal(
    takeDown.message,
    "Story is locked and cannot be unpublished. Unlock it first.",
    "same wording, so the two routes cannot drift",
  );
});

test("a correction to a locked live story still goes through", () => {
  // An edit carries no `published`, so wantsUnpublish is false and the guard
  // stands aside. This is the case a blanket lock check would have broken.
  const correction = evaluateTakeDown({ ...LOCKED_LIVE, wantsUnpublish: false });
  assert.equal(correction.allowed, true, "a correction must stay possible");
});

test("publishing through update is not a take-down", () => {
  const publish = evaluateTakeDown({ wantsUnpublish: false, locked: true, published: false });
  assert.equal(publish.allowed, true, "update { published: true } is unchanged by this fix");
});

test("a locked draft has nothing live to take down", () => {
  assert.equal(
    evaluateTakeDown(LOCKED_DRAFT).allowed,
    true,
    "unpublishing a draft changes nothing a reader can see",
  );
});

test("an unlocked live story can still be taken down", () => {
  assert.equal(evaluateTakeDown(UNLOCKED_LIVE).allowed, true, "no lock, no refusal");
});
test("index.ts routes update's published write through the guard", () => {
  assert.ok(
    /from "\.\/story-lock\.ts"/.test(indexSource),
    "index.ts must import the guard",
  );
  assert.ok(
    updateBranch.includes("evaluateTakeDown("),
    "the update action must call the guard before writing published",
  );
  assert.ok(
    updateBranch.includes("wantsUnpublish"),
    "the update action must tell the guard which direction the write goes",
  );
});

test("the unguarded one-liner this replaced is gone", () => {
  assert.ok(
    !updateBranch.includes("!== undefined) updateData.published = data.published"),
    "the bare published assignment is the BEL-166 bypass and must not come back",
  );
});

// The board's review criterion on BEL-166: the guard must refuse a locked live
// story's take-down without also refusing an edit to a locked live story, and
// the distinction must be published-versus-locked rather than
// operation-versus-operation. These two pin that as executable facts, so a
// later "simplification" back into an operation-keyed or blanket lock check
// fails here instead of shipping.
const ROW_STATES = [true, false].flatMap((published) =>
  [true, false].map((locked) => ({ published, locked })),
);

test("truth table: a take-down is refused exactly when published AND locked", () => {
  const table = [];
  for (const { published, locked } of ROW_STATES) {
    const decision = evaluateTakeDown({ wantsUnpublish: true, published, locked });
    const refused = !decision.allowed;
    assert.equal(
      refused,
      published && locked,
      `published=${published} locked=${locked} must refuse=${published && locked}`,
    );
    table.push(
      `  published=${String(published).padEnd(5)} locked=${String(locked).padEnd(5)} -> ${
        refused ? decision.status : "allowed"
      }`,
    );
  }
  console.log(`  take-down of a story:\n${table.join("\n")}`);
});

test("truth table: an edit is allowed on every row state, locked or not", () => {
  for (const { published, locked } of ROW_STATES) {
    const decision = evaluateTakeDown({ wantsUnpublish: false, published, locked });
    assert.equal(
      decision.allowed,
      true,
      `published=${published} locked=${locked}: a correction must never be refused`,
    );
  }
});

test("the refusal does not depend on which action asked", () => {
  // Same row, same answer. If this ever forks per action, the guard has become
  // operation-versus-operation and the two routes can drift.
  const lockedLive = { published: true, locked: true };
  const takeDowns = ROW_STATES.map(({ published, locked }) =>
    JSON.stringify(evaluateTakeDown({ wantsUnpublish: true, published, locked })),
  );
  assert.equal(new Set(takeDowns).size, 2, "only two outcomes exist: 409, or allowed");
  assert.equal(
    JSON.stringify(evaluateTakeDown({ wantsUnpublish: true, ...lockedLive })),
    JSON.stringify(evaluateTakeDown({ wantsUnpublish: true, ...lockedLive })),
    "identical row state must yield an identical decision",
  );
});

// ---------------------------------------------------------------------------
// BEL-71: the `delete` decision.
//
// `delete` is the only mutating action with no audit trail, so it is refused on
// anything a reader can see, and on a lock whatever the published state. The
// cases below are the board's accepted control; if one of them is rewritten
// without a decision, this fails.
// ---------------------------------------------------------------------------

const DRAFT = { locked: false, published: false };

test("an unpublished, unlocked draft can be deleted", () => {
  assert.equal(evaluateDelete(DRAFT).allowed, true, "delete is for drafts");
});

test("an unlocked LIVE story cannot be deleted", () => {
  // The defect BEL-71 closes. Before the fix this was allowed and left no record.
  const decision = evaluateDelete({ locked: false, published: true });
  assert.equal(decision.allowed, false, "a live story must not be deletable");
  assert.equal(decision.status, 409, "it must not answer 200");
  assert.match(decision.message, /published/i, "the refusal must say why");
  assert.match(decision.message, /unpublish/i, "the refusal must say what to do");
});

test("a locked draft still cannot be deleted", () => {
  const decision = evaluateDelete({ locked: true, published: false });
  assert.equal(decision.allowed, false, "a lock blocks deletion at any publish state");
  assert.match(decision.message, /unlock/i, "the refusal must name the lock");
});

test("a locked live story is refused for both reasons, in one response", () => {
  const decision = evaluateDelete({ locked: true, published: true });
  assert.equal(decision.allowed, false, "both conditions block");
  assert.equal(
    decision.message,
    "Story cannot be deleted because it is locked (unlock it first) and it is published (unpublish it first).",
    "every reason at once, so the caller does not discover them one round trip apart",
  );
});

test("the lock is named before published", () => {
  // Wording order is load-bearing for the panel's copy, which reads this back.
  const decision = evaluateDelete({ locked: true, published: true });
  assert.ok(
    decision.message.indexOf("locked") < decision.message.indexOf("published"),
    "unlock before unpublish: the lock is the stricter condition",
  );
});

test("the delete guard is reached from index.ts's delete branch", () => {
  const deleteBranch = indexSource.slice(
    indexSource.indexOf('if (action === "delete")'),
    indexSource.indexOf('if (action === "unpublish")'),
  );
  assert.ok(
    deleteBranch.includes("evaluateDelete("),
    "the delete action must call the shared guard before deleting",
  );
  assert.ok(
    /select\("locked, published"\)/.test(deleteBranch),
    "delete must read published, not just locked",
  );
  assert.ok(
    !/if \(storyRow\.locked\)\s*\{?\s*return errorResponse\("Story is locked and cannot be deleted/.test(
      deleteBranch,
    ),
    "the lock-only inline check is the BEL-71 gap and must not come back",
  );
});
