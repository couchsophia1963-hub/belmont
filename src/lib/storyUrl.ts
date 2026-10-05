/**
 * Story URLs, in one place.
 *
 * Issue: BEL-92. The app was mounted on a `HashRouter`, so the only working
 * story address was `/#/story/<slug>`. A reader arriving from a pasted link, a
 * search result, or a social card asked for `/story/<slug>`, got `index.html`
 * with a 200, and the router mounted on an empty hash and rendered the
 * homepage. Nothing upstream could see the drop.
 *
 * `App.tsx` now uses `BrowserRouter`, so these paths are real paths. Two things
 * must agree on that: the router's route table, and the URLs this file builds
 * for sharing. Keep them together here rather than inlining a string template
 * at each call site.
 */

/** The route `App.tsx` mounts a story on. Changing one means changing both. */
export const STORY_PATH_PREFIX = '/story/';

/**
 * The site-relative path for a story, e.g. `/story/wall-that-heals`.
 *
 * The slug is encoded because it arrives from the database: an unencoded
 * slug containing `/` or `?` would build a URL that points somewhere else.
 */
export function storyPath(slug: string): string {
  return `${STORY_PATH_PREFIX}${encodeURIComponent(slug)}`;
}

/**
 * The path the app is served under, with no trailing slash.
 *
 * Empty at the domain root, as on the live Bolt host. Not empty when the same
 * build is served from a subdirectory, which is how a GitHub Pages project
 * site (`/<repo>/`) and a Vite `base` setting both work. A share button that
 * ignored this would hand readers `https://host/story/<slug>` from a site that
 * actually lives at `https://host/<repo>/story/<slug>`, which is a 404.
 *
 * `pathname` is expected to be a path within this app. Any `/story/<slug>`
 * tail is removed first, so calling this from a story page yields the same
 * base as calling it from the homepage.
 */
export function siteBasePath(pathname: string): string {
  const withoutStory = pathname.replace(/\/story\/[^/]*\/?$/, '/');
  const trimmed = withoutStory.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed;
}

/**
 * The absolute URL to hand a reader when a story is shared.
 *
 * `origin` and `pathname` are passed in rather than read off `window` so this
 * is a plain function: the share button supplies
 * `window.location.origin` and `window.location.pathname`, and it can be
 * checked for any deploy base without a browser.
 */
export function storyShareUrl(slug: string, origin: string, pathname: string): string {
  return `${origin}${siteBasePath(pathname)}${storyPath(slug)}`;
}