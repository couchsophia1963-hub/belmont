/**
 * Tests for the shared story-URL helpers (BEL-141).
 *
 * BEL-92 moved the site from `HashRouter` to `BrowserRouter`, which turned the
 * story address into a real path and made the share button's URL a thing that
 * can be wrong in a new way: the same build served from a domain root and from a
 * subdirectory (a GitHub Pages project site, or a Vite `base`) needs a different
 * prefix, and a share link built for the wrong one is a 404 for the reader who
 * receives it.
 *
 * `origin` and `pathname` are arguments rather than reads of `window`, so all of
 * this is checkable without a browser. Nothing here is mocked.
 */

import { describe, it, expect } from 'vitest';
import { STORY_PATH_PREFIX, siteBasePath, storyPath, storyShareUrl } from '@/lib/storyUrl';

describe('storyPath', () => {
  it('builds the path App.tsx routes on', () => {
    expect(STORY_PATH_PREFIX).toBe('/story/');
    expect(storyPath('wall-that-heals')).toBe('/story/wall-that-heals');
  });

  it('encodes a slug, so one cannot point the URL somewhere else', () => {
    // The slug comes from the database. An unencoded `?` or `/` would build an
    // address for a different page than the one this code means.
    expect(storyPath('a b')).toBe('/story/a%20b');
    expect(storyPath('a?b=1')).toBe('/story/a%3Fb%3D1');
    expect(storyPath('one/two')).toBe('/story/one%2Ftwo');
  });
});

describe('siteBasePath', () => {
  it('is empty at a domain root', () => {
    // The live Bolt host: the site is at `/`, so a story is `/story/<slug>`.
    expect(siteBasePath('/')).toBe('');
  });

  it('is empty on a story page at a domain root', () => {
    // The share button is also rendered on the story page itself, where the
    // pathname is already `/story/<slug>`. It must not read that as the base.
    expect(siteBasePath('/story/wall-that-heals')).toBe('');
    expect(siteBasePath('/story/wall-that-heals/')).toBe('');
  });

  it('keeps a subdirectory base, from the homepage and from a story page', () => {
    // GitHub Pages project sites and any Vite `base` serve the app under a
    // prefix. Getting this wrong yields a share link that 404s.
    expect(siteBasePath('/belmont')).toBe('/belmont');
    expect(siteBasePath('/belmont/')).toBe('/belmont');
    expect(siteBasePath('/belmont/story/wall-that-heals')).toBe('/belmont');
  });

  it('handles a deeper subdirectory', () => {
    expect(siteBasePath('/news/site/')).toBe('/news/site');
    expect(siteBasePath('/news/site/story/a-slug')).toBe('/news/site');
  });
});

describe('storyShareUrl', () => {
  const ORIGIN = 'https://belmont-county-news.pages.dev';

  it('builds a root-domain share URL from the homepage', () => {
    expect(storyShareUrl('wall-that-heals', ORIGIN, '/')).toBe(
      `${ORIGIN}/story/wall-that-heals`
    );
  });

  it('builds the same root-domain share URL from the story page itself', () => {
    // ShareButton reads `window.location.pathname` and it renders on the story
    // page. If the pathname leaked into the URL the link would come out as
    // `/story/<slug>/story/<slug>`, which is exactly what BEL-92 fixed.
    expect(storyShareUrl('wall-that-heals', ORIGIN, '/story/wall-that-heals')).toBe(
      `${ORIGIN}/story/wall-that-heals`
    );
  });

  it('keeps the subdirectory prefix, from the homepage and from a story page', () => {
    const expected = `${ORIGIN}/belmont/story/wall-that-heals`;
    expect(storyShareUrl('wall-that-heals', ORIGIN, '/belmont/')).toBe(expected);
    expect(storyShareUrl('wall-that-heals', ORIGIN, '/belmont/story/wall-that-heals')).toBe(
      expected
    );
  });

  it('encodes the slug in the share URL', () => {
    expect(storyShareUrl('one/two', ORIGIN, '/')).toBe(
      `${ORIGIN}/story/one%2Ftwo`
    );
  });

  it('never produces a double slash at the origin', () => {
    expect(storyShareUrl('a-slug', 'https://example.test/', '/')).toBe(
      'https://example.test/story/a-slug'
    );
  });
});