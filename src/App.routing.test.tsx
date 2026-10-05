/**
 * Routing tests for the real `App` (BEL-141).
 *
 * These come from a harness built by hand to review PR #11 (BEL-121). That
 * review needed to know one thing — does `/story/<slug>` mount the story page,
 * or does it quietly render the homepage — and the only reliable answer was to
 * render the app at a path and read back what settled. That was the second time
 * this area was audited by hand, after BEL-74 found the original defect, and
 * both times the audit was a person reading a diff.
 *
 * Each test mounts the actual `App` with its actual `BrowserRouter` and asserts
 * on text only that page renders. It does not assert on the router's internals,
 * the route table, or a component's name: a test that reimplements the route
 * matching would pass while the site was broken, which is the failure mode this
 * whole issue exists to end. The queries are settled locally by
 * `test/supabaseMock.ts`, so nothing here needs a network or a database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', async () => {
  const mock = await import('@/test/supabaseMock');
  return { supabase: mock.supabase };
});

import App from '@/App';
import { resetSupabaseMock, setSession, setTableResult } from '@/test/supabaseMock';

/**
 * `BrowserRouter` reads `window.location`, so the path under test has to be the
 * real location before the app mounts. jsdom lets a test push history entries,
 * which is the closest stand-in for a reader typing an address.
 */
function renderAppAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

const HOMEPAGE_TEXT = 'Recent Stories';
const NOT_FOUND_HEADING = 'We could not find that page';

beforeEach(() => {
  resetSupabaseMock();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('route: /story/:slug', () => {
  it('mounts StoryDetailPage, not HomePage', async () => {
    // A real row, so the assertion is on the story's own headline rather than on
    // the "Failed to load story" fallback. Both prove the page mounted; the row
    // proves it also received the slug and rendered it.
    setTableResult('stories', {
      data: {
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'wall-that-heals',
        title: 'The Wall That Heals',
        excerpt: 'A short excerpt.',
        body: 'First paragraph.\n\nSecond paragraph.',
        image_url: null,
        category: 'Local News',
        author_id: null,
        is_headline: false,
        published: true,
        locked: false,
        locked_until: null,
        created_at: '2026-10-01T12:00:00.000Z',
        updated_at: '2026-10-01T12:00:00.000Z',
      },
      error: null,
    });

    renderAppAt('/story/wall-that-heals');

    // This is the BEL-92 regression in one assertion. Under a `HashRouter`, or
    // with the catch-all ordered before this route, this path rendered the
    // homepage with a 200 and no error anywhere.
    expect(await screen.findByRole('heading', { name: 'The Wall That Heals' })).toBeTruthy();
    expect(screen.queryByText(HOMEPAGE_TEXT)).toBeNull();
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
  });

  it('renders the story not-found state when no row matches the slug', async () => {
    // `maybeSingle()` on no match is `{data: null, error: null}`, which is a
    // different thing from a query error. Both land on StoryDetailPage; only
    // this one says "Story not found".
    setTableResult('stories', { data: null, error: null });

    renderAppAt('/story/never-published');

    expect(await screen.findByText('Story not found')).toBeTruthy();
    expect(screen.queryByText(HOMEPAGE_TEXT)).toBeNull();
  });
});

describe('route: catch-all', () => {
  it('mounts NotFoundPage for an unknown path, not HomePage', async () => {
    renderAppAt('/no-such-page');

    // The other half of the same regression: a mistyped or retired slug used to
    // render the homepage, so a broken link was indistinguishable from the front
    // page.
    expect(
      await screen.findByRole('heading', { name: NOT_FOUND_HEADING })
    ).toBeTruthy();
    expect(screen.queryByText(HOMEPAGE_TEXT)).toBeNull();
    expect(document.title).toBe('Page not found — Belmont County News');
  });

  it('echoes the requested path so a mistyped slug is visible', async () => {
    renderAppAt('/no-such-page/typo-here');

    // The address is on the page on purpose: a reader who followed a bad link
    // needs to see which address missed.
    expect(await screen.findByText('/no-such-page/typo-here')).toBeTruthy();
  });

  it('leaves a retired story slug to the story route, not the 404 page', async () => {
    // No row matches, and no error either: `maybeSingle()` on no match settles
    // that way, which is the state a retired slug is really in.
    setTableResult('stories', { data: null, error: null });

    // `/story/<anything>` matches the story route, so a retired slug lands on
    // StoryDetailPage and renders its own "Story not found" state rather than
    // the catch-all. That is the intended split: the catch-all handles addresses
    // that are not a shape the site has, and the story route handles a well-formed
    // story address whose story is gone. Asserted here because the two are easy to
    // confuse, and swapping them would change what a reader is told.
    renderAppAt('/story/a-slug-that-was-retired');

    expect(await screen.findByText('Story not found')).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: NOT_FOUND_HEADING })
    ).toBeNull();
    expect(screen.queryByText(HOMEPAGE_TEXT)).toBeNull();
  });
});

describe('the catch-all does not swallow a real route', () => {
  it('mounts AuthPage at /auth', async () => {
    renderAppAt('/auth');

    expect(
      await screen.findByRole('heading', { name: 'Welcome Back' })
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
    expect(screen.queryByText(HOMEPAGE_TEXT)).toBeNull();
  });

  it('mounts DashboardPage at /dashboard for a signed-in writer', async () => {
    // Signed in, or the dashboard redirects to /auth and this test would pass
    // for the wrong reason: it would be asserting on the auth page it was sent
    // to. The point here is that `/dashboard` reaches the dashboard and not the
    // catch-all.
    setSession({ id: 'user-1' });
    setTableResult('profiles', {
      data: {
        id: 'user-1',
        email: 'writer@belmontnews.local',
        display_name: 'Ada Writer',
        role: 'writer',
      },
      error: null,
    });

    renderAppAt('/dashboard');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
  });

  it('mounts StoryManagerPage at /stories for a signed-in writer', async () => {
    setSession({ id: 'user-1' });
    setTableResult('profiles', {
      data: {
        id: 'user-1',
        email: 'writer@belmontnews.local',
        display_name: 'Ada Writer',
        role: 'writer',
      },
      error: null,
    });

    renderAppAt('/stories');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Story Manager' })).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
  });

  it('still sends a signed-out visitor from /dashboard to the sign-in page', async () => {
    // The catch-all must not be what performs the redirect. If it were, a
    // signed-out visitor would see a 404 page instead of a sign-in prompt.
    renderAppAt('/dashboard');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Welcome Back' })
      ).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
  });
});

describe('route: /', () => {
  it('mounts HomePage at the domain root', async () => {
    // The baseline. If this stops holding, the negative assertions in the other
    // tests are no longer evidence of anything.
    setTableResult('weather_forecasts', { data: [], error: null });
    setTableResult('stories', { data: [], error: null });

    renderAppAt('/');

    expect(await screen.findByText(HOMEPAGE_TEXT)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
  });
});