/**
 * A mutating Supabase call is not a success/failure signal. It reports whether the
 * statement was accepted, not whether it changed a row.
 *
 * Postgres documents the trap in the RLS docs for UPDATE and DELETE alike: rows
 * filtered out by a policy's USING clause "are silently suppressed; no error is
 * reported". PostgREST then answers 204 No Content with a zero-length
 * Content-Range, so supabase-js hands back `{ data: null, error: null }` --
 * byte-identical to what a caller sees when the write landed.
 *
 * The only way to observe the difference is to ask for the rows back. `.select('id')`
 * turns the statement into `... RETURNING id`, and an empty array then means "the
 * policy refused every row", which is the one thing `error` can never tell you.
 *
 * Why a helper rather than a per-call `if (!data?.length)`: this has to be the
 * default on every mutating call, not a thing each author remembers. The original
 * defect was a branch written specifically to catch this and never able to fire,
 * because `error.message.includes('row-level security')` is a string PostgREST does
 * not send on this path. A helper makes the safe shape the short one.
 *
 * INSERT is deliberately not routed through here. A row that fails the INSERT
 * policy's WITH CHECK raises an error rather than being suppressed, so `error` is
 * already the whole story on that path. Only UPDATE and DELETE go quiet.
 */

/** The `RETURNING` payload every mutating call in this app asks for. */
export type AffectedRows = { id: string }[] | null;

export type WriteOutcome =
  | { ok: true; rows: number }
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'error'; message: string };

/**
 * Classify a mutating write that used `.select(...)`.
 *
 * `error` wins over an empty row set. On an error response PostgREST returns no
 * body, so `data` is null for both a real failure and a refusal; reporting a
 * refusal when the write actually errored would replace a diagnosable message with
 * a vague one.
 *
 * A null `data` with a null `error` is treated as a refusal, not a success. That
 * combination means PostgREST answered 204 without a representation body -- it
 * means the caller forgot `.select(...)`, and there is nothing to observe. Calling
 * it a success there is the exact defect this file exists to prevent.
 */
export function writeOutcome(data: AffectedRows, error: { message: string } | null): WriteOutcome {
  if (error) return { ok: false, reason: 'error', message: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'refused' };
  return { ok: true, rows: data.length };
}

/**
 * The sentence to show an operator, keyed to why the write did not land.
 *
 * `subject` names the thing in the panel's own language ("story", "API key",
 * "role") so the message reads as this app talking rather than as a driver error.
 * It is deliberately not a generic "operation failed": the operator needs to know
 * the database refused them, not that the network hiccuped.
 */
export function writeFailureMessage(
  outcome: Extract<WriteOutcome, { ok: false }>,
  subject: string,
): string {
  if (outcome.reason === 'error') return `Failed to save the ${subject}: ${outcome.message}`;
  return `Not saved. A database policy refused this change, so the ${subject} was left as it was.`;
}
