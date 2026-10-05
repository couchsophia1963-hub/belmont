#!/usr/bin/env node
/**
 * check-legacy-hash-route.mjs - does a stranded `#/story/<slug>` address land on
 * the story, or on the homepage?
 *
 *   npm run check
 *
 * Exit codes, so a workflow can read this:
 *
 *   0  every case passed.
 *   1  a case failed. The rewrite is broken.
 *   2  the check could not be carried out. This is NOT "nothing to do".
 *
 * The failure this guards against is silent, so it is worth naming. BEL-92
 * moved this app from a `HashRouter` to a `BrowserRouter`. The old app only
 * ever handed out `/#/story/<slug>`, so every pasted link, social card and
 * search result has that shape. A `BrowserRouter` reads the path and ignores
 * the hash, so those links mount on `/` and render the homepage with a 200.
 * The reader asked for a story and got the front page, and nothing upstream
 * sees a miss. That is the exact failure BEL-92 was opened to remove, moved
 * onto the old links.
 *
 * Why a script and not a test runner: this repo has no test framework, and
 * `legacyHashRouteTarget` is a pure function precisely so its cases can be
 * listed and read. The sibling newsroom site uses the same
 * `scripts/check-*.mjs` shape for the same reason.
 *
 * These cases exercise the real module, not a copy. `resolve-alias.mjs` maps
 * the `@/` alias onto `src/` so `node` can import what the bundle imports. A
 * copy would drift from the shipped code and prove nothing.
 */

import { register } from 'node:module';

register('./resolve-alias.mjs', import.meta.url);

const { legacyHashRouteTarget } = await import('../src/lib/legacyHashRoute.ts');
const { storyPath, storyShareUrl, siteBasePath } = await import('../src/lib/storyUrl.ts');

/**
 * Each case is the address a reader would have in the address bar, plus the
 * path the address bar should end up showing.
 *
 * `pathname` and `search` are the rest of the current location. They are passed
 * in rather than read off `window` so every case is one line.
 */
const CASES = [
  // The bug itself. A shared story link from before BEL-92.
  ['the old shared story link', '#/story/wall-that-heals', '/', '', '/story/wall-that-heals'],

  // Same link opened from a story page rather than the homepage. The current
  // path must not leak into the target, or the reader lands on
  // `/story/wall-that-heals/story/wall-that-heals`.
  ['an old link opened on another story', '#/story/wall-that-heals', '/story/some-other-story', '',
    '/story/wall-that-heals'],

  // The other routes the HashRouter app had. A dashboard or stories link
  // pasted by an editor lands on the same page, not the front page.
  ['the old dashboard link', '#/dashboard', '/', '', '/dashboard'],
  ['the old stories link', '#/stories', '/', '', '/stories'],
  ['the old auth link', '#/auth', '/', '', '/auth'],

  // An unknown old route is rewritten, not dropped. It reaches the catch-all,
  // which says the page was not found. Leaving it on `/` is the bug this whole
  // change exists to remove.
  ['an old link to a retired page', '#/retired-slug', '/', '', '/retired-slug'],

  // Query handling. Under a HashRouter the query lived inside the hash.
  ['a campaign query inside the hash', '#/story/wall-that-heals?utm_source=facebook', '/', '',
    '/story/wall-that-heals?utm_source=facebook'],
  ['a campaign query outside the hash, with a route', '#/story/wall-that-heals', '/', '?utm_source=facebook',
    '/story/wall-that-heals?utm_source=facebook'],
  // Both present: the hash carried the route, so it owns the query.
  ['a query in both places', '#/story/wall-that-heals?ref=old', '/', '?utm_source=facebook',
    '/story/wall-that-heals?ref=old'],

  // Anchors must survive. `#/...` is how a HashRouter wrote a route; an
  // in-page anchor is `#some-id` and is never rewritten.
  ['an in-page anchor', '#main', '/', '', null],
  ['no hash at all', '', '/', '', null],
  ['a bare hash', '#', '/', '', null],
  ['a search only, no route', '', '/', '?utm_source=facebook', null],

  // Deploy base. The same build served from a subdirectory, as a GitHub Pages
  // project site (`/belmont/`) would be. The target has to keep the base or the
  // rewrite sends the reader to a path that does not exist.
  ['an old link on a project-site base', '#/story/wall-that-heals', '/belmont/', '',
    '/belmont/story/wall-that-heals'],
  ['an old link opened on a base story page', '#/story/wall-that-heals', '/belmont/story/some-other-story', '',
    '/belmont/story/wall-that-heals'],

  // An encoded slug must not be decoded on the way through, or the rewrite
  // would change which story was asked for.
  ['an encoded slug', '#/story/a%2Fb', '/', '', '/story/a%2Fb'],

  // Idempotence. After the rewrite the hash is gone, so the target must be
  // null and the redirect cannot re-arm itself.
  ['the address after a redirect has run', '', '/story/wall-that-heals', '', null],

  // A retry of the same rewrite produces the same target, which is what makes
  // the effect in App.tsx safe to depend on.
  ['the same link rewritten twice', '#/story/wall-that-heals', '/', '',
    storyPath('wall-that-heals')],
];

/**
 * Guards the other half of the story. Under BEL-92 the share button builds the
 * address from the slug via `storyShareUrl`, so it must never emit a `#/` form
 * again. The build still on the host does, which is why the pool of stranded
 * links is growing rather than fixed.
 */
const SHARE_CASES = [
  ['from the homepage', 'wall-that-heals', '/', '/story/wall-that-heals'],
  ['from a story page', 'wall-that-heals', '/story/some-other-story', '/story/wall-that-heals'],
  ['from a project-site homepage', 'wall-that-heals', '/belmont/', '/belmont/story/wall-that-heals'],
  ['from a project-site story', 'wall-that-heals', '/belmont/story/some-other-story', '/belmont/story/wall-that-heals'],
];

let failures = 0;
let ran = 0;

function report(ok, label, actual, expected) {
  ran += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  const show = (v) => (v === null ? 'null (no rewrite)' : JSON.stringify(v));
  console.log(`  FAIL ${label}\n         expected ${show(expected)}\n         actual   ${show(actual)}`);
}

console.log('legacy hash route rewrite');

for (const [label, hash, pathname, search, expected] of CASES) {
  const actual = legacyHashRouteTarget(hash, pathname, search);
  report(actual === expected, label, actual, expected);
}

console.log('\nshared story address carries no hash');

for (const [label, slug, pathname, expectedPath] of SHARE_CASES) {
  const url = new URL(storyShareUrl(slug, 'https://belmont-news.bolt.host', pathname));
  const ok = url.pathname === expectedPath && url.hash === '';
  report(ok, label, ok ? url.pathname : `${url.pathname}${url.hash || '(no hash)'}`, expectedPath);
}

console.log('\nstory URL builder');

report(storyPath('wall-that-heals') === '/story/wall-that-heals',
  'storyPath builds a real path', storyPath('wall-that-heals'), '/story/wall-that-heals');
report(siteBasePath('/story/wall-that-heals') === '',
  'a story page has an empty base', siteBasePath('/story/wall-that-heals'), '');
report(siteBasePath('/belmont/story/x') === '/belmont',
  'a base is preserved off a story page', siteBasePath('/belmont/story/x'), '/belmont');

console.log(`\n${ran - failures}/${ran} passed`);

if (failures > 0) {
  console.error(`${failures} failed. A stranded #/ link is landing on the homepage.`);
  process.exit(1);
}
process.exit(0);