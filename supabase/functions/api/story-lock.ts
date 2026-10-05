/**
 * The lock decisions behind `update { published: false }` and `delete`, kept free
 * of Deno and of Supabase so the stub harness beside it can exercise them with
 * plain Node (`node supabase/functions/api/story-lock.stub.test.mjs`). The edge
 * function in `index.ts` is the only production caller.
 */

export interface TakeDownInput {
  /** What the caller asked for. Any falsy `published` is a take-down. */
  wantsUnpublish: boolean;
  /** `stories.locked` for the row being written. */
  locked: boolean;
  /** `stories.published` for the row as it stands before this write. */
  published: boolean;
}

export type TakeDownDecision =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

/**
 * A lock freezes a live story. Correcting one must stay possible, so this
 * refuses a take-down and never an edit: a locked story still takes a corrected
 * headline, body, or image. It also refuses only what is live — unpublishing a
 * draft changes nothing a reader can see, so the lock has nothing to protect
 * there.
 *
 * Same 409 and same wording as the check in `unpublish`, so the two routes
 * cannot drift apart in what a writer is told.
 */
export function evaluateTakeDown(input: TakeDownInput): TakeDownDecision {
  if (!input.wantsUnpublish) return { allowed: true };
  if (!input.published) return { allowed: true };
  if (input.locked) {
    return {
      allowed: false,
      status: 409,
      message: "Story is locked and cannot be unpublished. Unlock it first.",
    };
  }
  return { allowed: true };
}

export interface DeleteInput {
  /** `stories.locked` for the row being deleted. */
  locked: boolean;
  /** `stories.published` for the row being deleted. */
  published: boolean;
}

/**
 * Whether `delete` may remove a story row (BEL-71).
 *
 * `delete` is the only mutating action here with no audit trail: it leaves the
 * row gone rather than a row with `published = false`. So it is refused on
 * anything a reader can currently see, and refused on a lock, whatever the
 * `published` state. `update` corrects a live story; `unpublish` takes it down
 * and leaves the record. `delete` is for drafts and for mistakes that never went
 * out.
 *
 * Both conditions are collected before answering, so a caller told "unpublish
 * it first" is not sent straight back after doing that and told "unlock it
 * first". One round trip, every reason.
 *
 * The editor's `locked` case still names the lock first, because that is the
 * condition they must clear before anything else and it reads as the stricter
 * one.
 */
export function evaluateDelete(input: DeleteInput): TakeDownDecision {
  if (!input.published && !input.locked) return { allowed: true };

  const blocked: string[] = [];
  if (input.locked) blocked.push("it is locked (unlock it first)");
  if (input.published) blocked.push("it is published (unpublish it first)");

  return {
    allowed: false,
    status: 409,
    message: `Story cannot be deleted because ${blocked.join(" and ")}.`,
  };
}