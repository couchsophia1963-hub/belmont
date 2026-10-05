import type { PostgrestError } from '@supabase/supabase-js';

// comments_public is published by
// supabase/migrations/20261005160000_comments_public_view.sql. Until that file is
// applied to the Belmont News project, PostgREST answers every read of the view
// with a missing-relation error: PGRST205, HTTP 404, no rows. The site is right to
// fail closed on that, but it is a known state rather than a broken one, so a
// reader is told comments are closed and not that something failed.
const MISSING_RELATION_CODES = new Set(['PGRST205', '42P01']);

// PGRST200 is deliberately absent, and it also says "in the schema cache", so the
// code is authoritative whenever one is present and the message below is only read
// when it is not. That is the case of a proxy or edge worker that rewrites the code
// away. A missing *relationship* means the schema disagrees with the query we send,
// which is a real fault and keeps the visible error.
const MISSING_RELATION_MESSAGE = /does not exist|could not find the table/i;

// The status is not on the error: postgrest-js returns it beside the error, and the
// caller destructures only { data, error }. So the code and the message are what we
// have to classify on.
export function isCommentsViewMissing(error: PostgrestError | null): boolean {
  if (!error) return false;
  if (error.code) return MISSING_RELATION_CODES.has(error.code);
  return MISSING_RELATION_MESSAGE.test(error.message ?? '');
}
