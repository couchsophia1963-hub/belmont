import { supabase } from '@/lib/supabase';

/**
 * The headline invariant, in one place.
 *
 * Issue: BEL-233. "Exactly one story is the headline" was held by two sequential
 * client writes in `StoryManagerPage`, and the first write's result was discarded
 * entirely. A dropped request, a timeout or a PostgREST 500 on the demotion left
 * the old headline set, the new story was then promoted on top of it, and
 * `HomePage`'s `.maybeSingle()` returns an *error* when it is handed more than one
 * row. One admin click that the panel called success replaced the whole public
 * homepage with an error state, weather and story feed included.
 *
 * Nothing in the database refused that second headline. `idx_stories_headline` is a
 * plain partial index, not a unique one, so the client sequence was the whole of
 * the enforcement. The database half of the fix is `set_story_headline` plus a
 * unique partial index; it is blocked on database access. See the issue.
 *
 * What this does, until that lands:
 *   - it refuses to promote a story when the demotion did not happen, which is the
 *     write that produced two headlines;
 *   - it checks every write instead of discarding it, error first;
 *   - it puts the previous headline back if the promotion fails;
 *   - it reads the flag back afterwards, because two editors clicking at once make
 *     both writes succeed and still leave two headlines.
 *
 * It cannot make the swap atomic. A browser closing between the demotion and the
 * promotion still leaves no headline, which is why the RPC is the real fix.
 */

/** Which column identifies the story. `slug` is used before a new story has an id. */
export type HeadlineTarget = { column: 'id' | 'slug'; value: string };

export type HeadlineOutcome = { ok: true } | { ok: false; message: string };

type WriteOutcome = { ok: true; rows: number } | { ok: false; message: string };

/** One story row, reduced to what the invariant needs. */
type HeadlineRow = { id: string; slug: string };

/**
 * `confirmable` says the caller can SELECT the row back, which it can only do for a
 * published story (`stories_public_read` is `USING (published = true)`). RLS filters
 * the rows PostgREST returns from a write, so for a draft an empty result is
 * indistinguishable from a refused write. Pass `false` for a draft and the helper
 * checks errors only instead of reporting a refusal that did not happen.
 */
type HeadlineOptions = { confirmable?: boolean };

async function setFlag(where: HeadlineTarget, value: boolean): Promise<WriteOutcome> {
  const { data, error } = await supabase
    .from('stories')
    .update({ is_headline: value })
    .eq(where.column, where.value)
    .select('id');
  if (error) return { ok: false, message: error.message };
  return { ok: true, rows: data?.length ?? 0 };
}

/** Demotes every other story. The returned count covers published rows only. */
async function clearOthers(target: HeadlineTarget): Promise<WriteOutcome> {
  const { data, error } = await supabase
    .from('stories')
    .update({ is_headline: false })
    .neq(target.column, target.value)
    .select('id');
  if (error) return { ok: false, message: error.message };
  return { ok: true, rows: data?.length ?? 0 };
}

async function readHeadlines(): Promise<
  { ok: true; rows: HeadlineRow[] } | { ok: false; message: string }
> {
  const { data, error } = await supabase.from('stories').select('id, slug').eq('is_headline', true);
  if (error) return { ok: false, message: error.message };
  return { ok: true, rows: (data ?? []) as HeadlineRow[] };
}

/** The read-back is keyed on whichever column the caller gave us. */
const keyOf = (row: HeadlineRow, column: HeadlineTarget['column']) =>
  column === 'id' ? row.id : row.slug;

async function putBack(previousId: string | null, reason: string): Promise<HeadlineOutcome> {
  if (!previousId) {
    return {
      ok: false,
      message:
        `This story was not promoted (${reason}), so no headline is set right now. ` +
        'The homepage falls back to the most recent story. Set a headline here to restore it.',
    };
  }
  const restored = await setFlag({ column: 'id', value: previousId }, true);
  if (!restored.ok) {
    return {
      ok: false,
      message:
        `This story was not promoted (${reason}), and the previous headline could not be ` +
        `put back (${restored.message}). No headline is set right now. Set one here.`,
    };
  }
  return { ok: false, message: `This story was not promoted (${reason}). The previous headline was put back.` };
}

/**
 * Confirms one headline, and repairs the case the per-write checks cannot see: two
 * editors promoting at the same time, where both writes report success.
 */
async function settle(target: HeadlineTarget, confirmable: boolean): Promise<HeadlineOutcome> {
  if (!confirmable) return { ok: true };

  const after = await readHeadlines();
  if (!after.ok) {
    return {
      ok: false,
      message:
        `The headline was changed, but the read-back failed (${after.message}). ` +
        'Check the homepage before publishing anything else.',
    };
  }
  const isTarget = (row: HeadlineRow) => keyOf(row, target.column) === target.value;
  const others = after.rows.filter((row) => !isTarget(row));
  if (others.length === 0 && after.rows.some(isTarget)) return { ok: true };

  const repaired = await clearOthers(target);
  if (!repaired.ok) {
    return {
      ok: false,
      message:
        `${after.rows.length} stories are flagged as the headline and the repair write ` +
        `failed (${repaired.message}). Until this is fixed the public homepage shows an error.`,
    };
  }
  const recheck = await readHeadlines();
  const settled = recheck.ok && recheck.rows.length === 1 && isTarget(recheck.rows[0]);
  if (!settled) {
    return {
      ok: false,
      message:
        `${after.rows.length} stories were flagged as the headline at once, and one repair ` +
        'pass did not settle it. Two editors are probably saving at the same time. ' +
        'The public homepage is at risk until one headline is left.',
    };
  }
  return {
    ok: false,
    message:
      `${after.rows.length} stories were flagged as the headline at once. This one is now the ` +
      'only headline, and the rest were cleared.',
  };
}

export async function setStoryHeadline(
  target: HeadlineTarget,
  nextIsHeadline: boolean,
  options: HeadlineOptions = {},
): Promise<HeadlineOutcome> {
  const confirmable = options.confirmable !== false;

  if (!nextIsHeadline) {
    const cleared = await setFlag(target, false);
    if (!cleared.ok) return { ok: false, message: `Could not clear the headline: ${cleared.message}` };
    if (confirmable && cleared.rows === 0) {
      return {
        ok: false,
        message: 'The write matched no story this account can read, so the headline was not cleared.',
      };
    }
    return { ok: true };
  }

  const before = await readHeadlines();
  if (!before.ok) {
    return {
      ok: false,
      message: `Could not read the current headline (${before.message}), so nothing was changed.`,
    };
  }
  const previousId =
    before.rows.find((row) => keyOf(row, target.column) !== target.value)?.id ?? null;

  const demoted = await clearOthers(target);
  if (!demoted.ok) {
    // This is the write whose failure produced two headlines. Promoting here anyway
    // is what took the homepage down, so stop even though it is not what was asked.
    return {
      ok: false,
      message:
        `Clearing the old headline failed (${demoted.message}), so this story was not ` +
        'promoted. The homepage still has exactly one headline.',
    };
  }

  // A demotion can also fail without an error: RLS filters the row out of the write,
  // so PostgREST reports success and the old headline is still set. Read it back
  // instead of trusting the result.
  if (confirmable && previousId) {
    const midway = await readHeadlines();
    if (!midway.ok) {
      return {
        ok: false,
        message:
          `Clearing the old headline could not be confirmed (${midway.message}), so this ` +
          'story was not promoted.',
      };
    }
    if (midway.rows.some((row) => row.id === previousId)) {
      return {
        ok: false,
        message:
          'Clearing the old headline did not take effect, so this story was not promoted. ' +
          'The homepage still has exactly one headline.',
      };
    }
  }

  const promoted = await setFlag(target, true);
  if (!promoted.ok || (confirmable && promoted.rows === 0)) {
    return putBack(
      previousId,
      promoted.ok ? 'the write matched no story this account can read' : promoted.message,
    );
  }

  return settle(target, confirmable);
}
