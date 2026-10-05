/**
 * Old `#/...` links, and where they should go now (BEL-142).
 *
 * Issue: BEL-92 switched this app from a `HashRouter` to a `BrowserRouter` so
 * that `/story/<slug>` is a real path. The switch fixed incoming links but
 * stranded every link the old app had already handed out: under a
 * `HashRouter` the only story address the site ever produced was
 * `/#/story/<slug>`, so that is what is in every pasted link, social card and
 * search result.
 *
 * `BrowserRouter` reads the path and ignores the hash, so `/#/story/<slug>`
 * mounts on `/` and renders the homepage with a 200. The reader gets the front
 * page for a story they asked for, and nothing upstream sees a miss. That is
 * the exact failure BEL-92 was opened to remove, moved onto the old links.
 *
 * The build currently on the host is still minting these: its share button
 * emits `${origin}${pathname}#/story/${slug}`. So the pool of them is growing
 * until a deploy carries the fixed share button, which makes this shim worth
 * more than a one-time tidy.
 *
 * This module only decides the target path. Performing the redirect is the
 * caller's job, so the rule can be checked without a browser.
 */

import { siteBasePath } from '@/lib/storyUrl';

/**
 * A `HashRouter` wrote its route after a `#`, always rooted: `#/story/<slug>`,
 * `#/auth`, `#/dashboard`, `#/stories`.
 *
 * An in-page anchor is `#some-id`, which never starts with `#/`. So this
 * prefix is what separates a stranded route from an ordinary fragment link, and
 * nothing here has to know the route table.
 */
const LEGACY_HASH_PREFIX = '#/';

/**
 * The path a legacy `#/...` address should be rewritten to, or `null` when the
 * hash is not one.
 *
 * `null` covers two cases the caller must not act on:
 *
 * - no hash, or an ordinary anchor such as `#main`. Rewriting those would
 *   break in-page links.
 * - a `#/...` hash that this function has already handled. After the redirect
 *   the browser replaces the URL, so the hash is gone. Returning `null` is what
 *   stops the redirect from re-arming itself.
 *
 * `hash` is `location.hash`, so it still carries the leading `#`. `pathname`
 * and `search` are the rest of the current location and decide the deploy base
 * and the query, both passed in rather than read off `window` so this stays a
 * plain function.
 *
 * An unknown legacy route is rewritten rather than dropped. `#/retired-slug`
 * became the homepage before, which is the bug; rewriting it lands on the
 * catch-all instead, which says the page was not found. To narrow this to the
 * known route table, match the path against the routes in `App.tsx` and return
 * `null` when it matches none.
 */
export function legacyHashRouteTarget(
  hash: string,
  pathname: string,
  search: string
): string | null {
  if (!hash.startsWith(LEGACY_HASH_PREFIX)) return null;

  const route = hash.slice(1);
  const query = route.includes('?') ? '' : search;

  // The hash held the whole route under a HashRouter, so it can carry its own
  // query, as in `#/story/slug?utm_source=x`. The query outside the hash is
  // kept when the hash has none, so `/#/story/slug?utm_source=x` and
  // `?utm_source=x#/story/slug` both arrive at the story with the campaign
  // intact rather than silently losing it.
  return `${siteBasePath(pathname)}${route}${query}`;
}