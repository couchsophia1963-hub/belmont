/**
 * The lock decision behind `update { published: false }`, kept free of Deno and
 * of Supabase so the stub harness beside it can exercise it with plain Node
 * (`node supabase/functions/api/story-lock.stub.test.mjs`). The edge function
 * in `index.ts` is the only production caller.
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