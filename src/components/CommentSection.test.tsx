/**
 * A write that fails after the reader has moved on (BEL-189).
 *
 * #17 (BEL-93) cleared the write error in the effect that runs on the story
 * transition, so a write error from a story the reader had left stopped being
 * carried forward. That closes the defect as it fired: before #17, any failed
 * write left a banner on every later navigation.
 *
 * What #17 cannot close is the ordering. The clearing happens when `storyId`
 * changes. A write that is still in flight at that moment has not failed yet, so
 * the effect clears an error that does not exist, and the rejection lands
 * afterwards, on whatever story is on screen by then:
 *
 *   reader deletes a comment on story A
 *     |- navigate to story B      <- the effect runs and clears nothing
 *     `- the delete rejects       <- setError fires, now on story B
 *
 * The same cross-story leak is therefore still reachable, and it needs only that
 * the reader be quick. These tests hold a write open across a story change and
 * then reject it, which is the one ordering the fix has to survive.
 *
 * The mock is local rather than shared, because the shared `supabaseMock.ts` was
 * built for routing and settles every table on a microtask. A race is defined
 * by *when* a query settles, so this one holds responses open and settles them by
 * hand. Responses are keyed by the table and the filters the component chained,
 * not by call order, because the number of reads of one table depends on when
 * the session resolves and an ordered queue would make the test assert on
 * incidental ordering instead of on the race.
 *
 * Assertions are on rendered text only, for the reason the routing tests read
 * text: a test that reimplements the component's own rules would pass against a
 * component that rendered nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

type MockError = { message: string; code: string };
interface MockResult {
  data: unknown;
  error: MockError | null;
}

interface Held {
  promise: Promise<MockResult>;
  settle: (result: MockResult) => void;
}

/** A response the test settles by hand, so a write can be held open. */
function held(): Held {
  let settle: (result: MockResult) => void = () => undefined;
  const promise = new Promise<MockResult>((res) => {
    settle = res;
  });
  return { promise, settle };
}

const ok = (data: unknown): MockResult => ({ data, error: null });
const failed = (message: string, code = 'MOCKED'): MockResult => ({
  data: null,
  error: { message, code },
});

type Filters = Record<string, unknown>;

/** Answer used when nothing more specific is registered for a query. */
const defaults = new Map<string, MockResult | Held>();
/** Answers registered for one table filtered a particular way. */
const responses = new Map<string, MockResult | Held>();

function key(table: string, filters: Filters): string {
  const sorted = Object.entries(filters).sort(([a], [b]) => (a < b ? -1 : 1));
  return `${table}:${sorted.map(([k, v]) => `${k}=${String(v)}`).join('&')}`;
}

let session: unknown = null;

/** Every query key the component actually issued, in order. */
const issued: string[] = [];

function answerFor(table: string, filters: Filters): PromiseLike<MockResult> {
  const queryKey = key(table, filters);
  issued.push(queryKey);
  const entry = responses.get(queryKey) ?? defaults.get(table);
  if (entry && 'settle' in entry) return entry.promise;
  if (entry) return Promise.resolve(entry);
  return Promise.resolve(failed(`no response registered for ${queryKey}`));
}

function builderFor(table: string) {
  const filters: Filters = {};
  const builder = {
    then(
      onFulfilled?: (value: MockResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve(answerFor(table, filters)).then(onFulfilled, onRejected);
    },
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    delete: () => builder,
    // The only filter the component chains on a query it awaits, and the one the
    // mock keys on. Everything else returns the builder, as in the shared mock:
    // a typo stays a TypeError instead of being swallowed by a Proxy.
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    neq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => builder,
    maybeSingle: () => builder,
  } as unknown as {
    then: PromiseLike<MockResult>['then'];
  } & Record<string, (...args: unknown[]) => unknown>;

  return builder;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from(table: string) {
      return builderFor(table);
    },
    auth: {
      async getSession() {
        return { data: { session }, error: null };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      async signOut() {
        return { error: null };
      },
    },
  },
}));

import { AuthProvider } from '@/lib/auth';
import { CommentSection } from '@/components/CommentSection';

const STORY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const COMMENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const READER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const DELETE_DENIED = 'permission denied for schema comments';
const INSERT_REFUSED = 'row-level security refused the insert';

const commentOn = (storyId: string) => ({
  id: COMMENT_ID,
  story_id: storyId,
  body: `A comment on ${storyId}.`,
  created_at: '2026-10-05T12:00:00.000Z',
  display_name: 'Mara Vance',
});

/**
 * A signed-in reader with a deletable comment on each story given.
 *
 * Signed in, because a signed-out reader gets no composer and no delete button,
 * and every assertion below would be against an empty section. `comments` is
 * registered per `story_id` because the deletable-id read is filtered by it, and
 * the delete is filtered by `id` instead, which is what tells the two apart.
 */
function signedInReaderWithComments(...storyIds: string[]): void {
  session = { user: { id: READER_ID } };
  defaults.set('profiles', ok({
    id: READER_ID,
    display_name: 'Idris Bello',
    email: 'idris@belmont.test',
    role: 'admin',
  }));
  for (const storyId of storyIds) {
    responses.set(key('comments_public', { story_id: storyId }), ok([commentOn(storyId)]));
    responses.set(key('comments', { story_id: storyId }), ok([{ id: COMMENT_ID }]));
  }
}

function renderSection(storyId: string) {
  return render(
    <AuthProvider>
      <CommentSection storyId={storyId} />
    </AuthProvider>
  );
}

/** Rerender with a new storyId, which is what navigation does to this component. */
function navigateTo(view: ReturnType<typeof renderSection>, storyId: string) {
  view.rerender(
    <AuthProvider>
      <CommentSection storyId={storyId} />
    </AuthProvider>
  );
}

beforeEach(() => {
  defaults.clear();
  responses.clear();
  issued.length = 0;
  session = null;
});

describe('a write error that settles after the reader has navigated (BEL-189)', () => {
  it('does not render a delete failure on the story the reader moved to', async () => {
    signedInReaderWithComments(STORY_A, STORY_B);
    const write = held();
    responses.set(key('comments', { id: COMMENT_ID }), write);

    const view = renderSection(STORY_A);
    // Waits for both reads the button depends on: the comment list and the
    // deletable-id query that runs alongside it.
    await screen.findByTitle('Delete comment');

    fireEvent.click(screen.getByTitle('Delete comment'));

    // The reader moves on while the write is still open. The transition effect
    // runs here and, on the current code, clears an error that does not exist.
    navigateTo(view, STORY_B);
    await screen.findByText(`A comment on ${STORY_B}.`);

    await act(async () => {
      write.settle(failed(DELETE_DENIED));
    });

    // The write failed on story A. The reader is on story B, so the banner must
    // not describe it. This is the whole defect.
    expect(screen.queryByText(DELETE_DENIED)).toBeNull();
    expect(screen.queryByText('Failed to load comments')).toBeNull();
  });

  it('still shows the failure on the story the write was made on', async () => {
    // The guard must not turn into "never show a write error". A write that fails
    // on the story the reader is still looking at is a real failure they need to
    // see, and this is #17's behaviour, which has to survive the fix.
    signedInReaderWithComments(STORY_A);
    const write = held();
    responses.set(key('comments', { id: COMMENT_ID }), write);

    renderSection(STORY_A);
    await screen.findByTitle('Delete comment');

    fireEvent.click(screen.getByTitle('Delete comment'));
    await act(async () => {
      write.settle(failed(DELETE_DENIED));
    });

    expect(await screen.findByText(DELETE_DENIED)).toBeDefined();
  });

  it('does not render a failed comment post on the story the reader moved to', async () => {
    // The same window through the insert. handleSubmit is a second write path
    // with its own setError, so covering only the delete would leave half the
    // defect in place.
    signedInReaderWithComments(STORY_A, STORY_B);
    const write = held();
    responses.set(key('comments', {}), write);

    const view = renderSection(STORY_A);
    await screen.findByText(`A comment on ${STORY_A}.`);

    fireEvent.change(screen.getByPlaceholderText('Share your thoughts...'), {
      target: { value: 'A reply.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));

    navigateTo(view, STORY_B);
    await screen.findByText(`A comment on ${STORY_B}.`);

    await act(async () => {
      write.settle(failed(INSERT_REFUSED));
    });

    expect(screen.queryByText(INSERT_REFUSED)).toBeNull();
  });

  it('still shows a failed comment post on the story it was made on', async () => {
    // The matching control for the insert path, so the third test's absence is
    // the guard and not a submit that never happened.
    signedInReaderWithComments(STORY_A);
    const write = held();
    responses.set(key('comments', {}), write);

    renderSection(STORY_A);
    await screen.findByText(`A comment on ${STORY_A}.`);

    fireEvent.change(screen.getByPlaceholderText('Share your thoughts...'), {
      target: { value: 'A reply.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    await act(async () => {
      write.settle(failed(INSERT_REFUSED));
    });

    expect(await screen.findByText(INSERT_REFUSED)).toBeDefined();
  });
});