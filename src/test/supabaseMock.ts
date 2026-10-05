/**
 * A stand-in for `src/lib/supabase.ts` that never touches the network.
 *
 * BEL-141. These tests exist to answer one question — which page does the router
 * settle on for a given path — and the answer must not depend on a live
 * Supabase project, a real session, or a row that may be edited by an editor
 * mid-run. Every query here resolves locally.
 *
 * The shape matters: the pages build PostgREST queries fluently
 * (`supabase.from(...).select(...).eq(...).order(...).limit(...)`) and then await
 * the chain itself, or await `.maybeSingle()`. So the mock returns a single
 * self-referential thenable on which every builder method returns the same
 * object. Awaiting it anywhere in the chain resolves the same result.
 *
 * Default behaviour is an error for every table, which is what the routing tests
 * use: a page that fails its query still proves which page it mounted, and a
 * passing test never depends on data that could change. Tests that need a row
 * to assert on call `setTableResult` for that table only.
 */

export interface MockQueryResult {
  data: unknown;
  error: { message: string; code: string } | null;
}

type Builder = {
  then: PromiseLike<MockQueryResult>['then'];
} & Record<string, (...args: unknown[]) => Builder>;

const QUERY_ERROR: MockQueryResult['error'] = {
  message: 'mocked: this test does not query a real database',
  code: 'MOCKED',
};

const tables = new Map<string, MockQueryResult>();

/** Null means signed out. Set by `setSession`. */
let session: unknown = null;

/**
 * Settle one table with a specific result. Every other table keeps erroring, so
 * a test that needs a row does not silently start depending on more of them.
 */
export function setTableResult(table: string, result: MockQueryResult): void {
  tables.set(table, result);
}

export function resetSupabaseMock(): void {
  tables.clear();
  session = null;
}

/**
 * Give the mock a signed-in session.
 *
 * Signed out, `/dashboard` and `/stories` both redirect to `/auth`, so a routing
 * test cannot tell those two apart from each other or from a typo that happened
 * to redirect. Signed in with a `profiles` row, each renders its own heading and
 * the catch-all test can assert the real thing.
 *
 * `profiles` must be given a row too: `AuthProvider` loads the profile by id and
 * leaves it null on error, and every admin page redirects when the profile is
 * null.
 */
export function setSession(user: { id: string }): void {
  session = { user } as unknown as null;
}

function resultFor(table: string): MockQueryResult {
  return tables.get(table) ?? { data: null, error: QUERY_ERROR };
}

function builderFor(table: string): Builder {
  // A Promise's own `then` is what makes this awaitable. Every Supabase builder
  // method resolves back to the same object, so `.select().eq().maybeSingle()`
  // and `.select().limit()` are both awaitable and both settle the same way.
  const builder = {
    then(
      onFulfilled?: (value: MockQueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve(resultFor(table)).then(onFulfilled, onRejected);
    },
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    delete: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    single: () => builder,
    maybeSingle: () => builder,
  } as unknown as Builder;

  return builder;
}

export const supabase = {
  from(table: string): Builder {
    return builderFor(table);
  },
  rpc(): Builder {
    return builderFor('__rpc__');
  },
  auth: {
    // Signed out by default, which is the branch a first-time reader gets and
    // the branch most likely to be mistaken for another page. `setSession` opts
    // a test into the signed-in branch where it needs to tell two admin pages
    // apart.
    async getSession(): Promise<{ data: { session: unknown }; error: null }> {
      return { data: { session }, error: null };
    },
    onAuthStateChange(): {
      data: { subscription: { unsubscribe: () => void } };
    } {
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
    async signInWithPassword(): Promise<{ error: null }> {
      return { error: null };
    },
    async signUp(): Promise<{ error: null; data: { user: null } }> {
      return { error: null, data: { user: null } };
    },
    async signOut(): Promise<{ error: null }> {
      return { error: null };
    },
  },
};