#!/usr/bin/env node
/**
 * check-host-routing.mjs - will deep links survive on this host?
 *
 *   node scripts/check-host-routing.mjs https://belmont-news.bolt.host
 *   npm run check:host -- https://belmont-news.bolt.host
 *
 * Exit codes:
 *
 *   0  the host serves the app for unknown paths. `BrowserRouter` deep links
 *      work here. Deploying this build is safe.
 *   1  the host does NOT serve the app for unknown paths. A request for
 *      `/story/<slug>` never reaches the route table, so it is answered by the
 *      host instead of the app.
 *   2  the check could not be carried out. This is NOT "nothing to do".
 *
 * Run this before every deploy to a new host. Read-only GETs, no writes.
 *
 * WHY THIS EXISTS
 *
 * This app runs on a `BrowserRouter` (BEL-92), so `/story/<slug>` is a real
 * path and the router has to see it. That only works if the host answers
 * unknown paths with the app shell rather than its own error page. Hosts
 * disagree about this, and the disagreement is silent:
 *
 *   belmont-news.bolt.host               /story/<slug> -> 200, the app
 *   belmont-county-news-b68j.bolt.host   /story/<slug> -> 404, the host's page
 *
 * Both are Bolt hosts in our notes. Nothing in the app or the build can tell
 * you which kind you are on, so a deploy to a host without SPA fallback makes
 * every clean deep link 404 while the homepage keeps rendering fine. It looks
 * healthy until a reader follows a shared story link. This turns that into a
 * check someone runs first.
 *
 * It also reports, without failing, whether the host answers unknown paths and
 * missing assets with a real 404. That is a separate host rule, tracked as
 * BEL-142 Part 1. It is reported rather than enforced because it is deploy
 * configuration and not something a client-side route can decide; enforcing it
 * here would block every deploy until the host rule exists.
 */

const HOST = (process.argv[2] || '').trim().replace(/\/+$/, '');
const TIMEOUT_MS = 15000;

/** A slug that matches `/story/:slug` but is not a story anyone published. */
const STORY_PROBE = '/story/zz-no-such-story-zz';
/** Not a route in the table. */
const ROUTE_PROBE = '/zz-no-such-route-zz';
/** A path under a real asset prefix, for the asset rule. */
const ASSET_PROBE = '/assets/zz-no-such-asset-zz.js';

/**
 * A marker that this response is a Vite app shell at all, used only to label
 * what came back. It is deliberately not the pass/fail signal: a host's own
 * "Website Not Found" page is also a React app with a `<div id="root">`, so
 * matching this proves nothing about who answered the request. The signal is
 * byte-identity with `/`, below.
 */
function looksLikeAnAppShell(body) {
  return /<div\s+id="root"|<script[^>]+type="module"/.test(body);
}

async function probe(base, path) {
  const url = `${base}${path}`;
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'belmont-check-host-routing/1.0' },
    });
  } catch (error) {
    return { path, ok: false, error: error.message };
  }

  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }

  return {
    path,
    ok: true,
    status: response.status,
    type: response.headers.get('content-type') || '',
    shell: looksLikeAnAppShell(body),
    bytes: body.length,
    body,
  };
}

function describe(result, sameAsRoot) {
  if (!result.ok) return `${result.path} -> request failed (${result.error})`;
  const origin =
    sameAsRoot === undefined ? '' : sameAsRoot ? ' [same as /]' : ' [DIFFERS from /]';
  return `${result.path} -> ${result.status} ${result.type.split(';')[0]} ${result.bytes}B` +
    `${origin}${result.shell ? ' [an app shell]' : ''}`;
}

if (!HOST) {
  console.error('usage: node scripts/check-host-routing.mjs <host-url>');
  process.exit(2);
}
if (!/^https?:\/\//.test(HOST)) {
  console.error(`not an http(s) URL: ${HOST}`);
  process.exit(2);
}

console.log(`host routing check: ${HOST}\n`);

const root = await probe(HOST, '/');
const story = await probe(HOST, STORY_PROBE);
const route = await probe(HOST, ROUTE_PROBE);
const asset = await probe(HOST, ASSET_PROBE);
const all = [root, story, route, asset];

if (all.some((r) => !r.ok)) {
  console.log(all.map(describe).join('\n'));
  console.error('\nCould not reach the host. Treat this as unknown, not as a pass.');
  process.exit(2);
}

console.log('Blocking: does a clean deep link reach the app?');

/**
 * SPA fallback, decided by byte-identity with `/`.
 *
 * A host with SPA fallback answers every unknown path with the same shell it
 * serves at `/`, so the router gets to see the real path. A host without it
 * answers with its own error page instead, and the router never runs. Same
 * status, same content-type, so only the bytes tell them apart.
 */
const sameAsRoot = (result) => result.body === root.body;

console.log(`  ${describe(root)}`);
console.log(`  ${describe(story, sameAsRoot(story))}`);

const broken = [];
if (root.status !== 200) broken.push(`/ returns ${root.status}, not the app`);
if (story.status !== 200 || !sameAsRoot(story)) {
  broken.push(
    `${STORY_PROBE} is answered by the host (${story.status}), not by the app`
  );
}

console.log('\nReported only: does an unknown path get a real 404? (BEL-142 Part 1)');
console.log(`  ${describe(route, sameAsRoot(route))}`);
console.log(`  ${describe(asset, sameAsRoot(asset))}`);
console.log(
  '  A 200 with the app shell here is expected today. It becomes a real 404\n' +
  '  when the host gains a rewrite rule, and this line starts saying so.'
);

console.log('');

if (broken.length) {
  console.error('This host has no SPA fallback. Do NOT deploy this build here:');
  for (const line of broken) console.error(`  - ${line}`);
  console.error('\nBrowserRouter needs the host to serve the app for unknown paths.');
  process.exit(1);
}

console.log('Deep links work on this host. Safe to deploy a BrowserRouter build.');
process.exit(0);