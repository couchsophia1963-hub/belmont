# Hosting

Where the site runs, what the host has to do, and how to check before a deploy.

## Where it is served today

`https://belmont-news.bolt.host`. The build is produced by `npm run build` and
uploaded through the Bolt project. There is no CI workflow and no GitHub Pages
site for this repo. Nothing here deploys itself; a deploy is a person pushing a
build to the host.

## The host must serve the app for unknown paths

This app uses `BrowserRouter` (BEL-92), so `/story/<slug>` is a real path and
the router has to receive it. That only works if the host answers a request for
an unknown path with the app shell rather than with its own error page.

Hosts disagree about this, and the disagreement is silent:

| Host | `/` | `/story/<slug>` | SPA fallback |
| --- | --- | --- | --- |
| `belmont-news.bolt.host` | 200, app shell | 200, app shell, same bytes as `/` | yes |
| `belmont-county-news-b68j.bolt.host` | 200, its own page | 404, its own page | no |

Measured 2026-10-05 by `npm run check:host -- <url>`, which is the check to run
before deploying to any host. Both are Bolt hosts, so the platform name tells
you nothing.

Deploying a `BrowserRouter` build to a host without SPA fallback leaves the
homepage working and makes every clean deep link a 404 at the host. Nothing in
the app fails, so it looks healthy until a reader follows a shared story link.
This is the reason the check is a separate script and not a comment.

```
npm run check:host -- https://the-host-you-are-about-to-use
```

Exit `0` means deep links work there. Exit `1` means do not deploy. Exit `2`
means the check could not run, which is not a pass.

## The host rule this host is missing (BEL-142 Part 1)

Today every path on `belmont-news.bolt.host` returns `index.html` with a `200`,
including paths that are not pages at all:

| Path | Status | Bytes |
| --- | --- | --- |
| `/` | 200 | 795 |
| `/story/<slug>` | 200 | 795 |
| `/nonexistent-route-xyz` | 200 | 795 |
| `/assets/nope-does-not-exist.js` | 200 | 795 |

Measured 2026-10-05. Byte-identical for all four, so the host is answering with
the app shell every time, and a missing JavaScript asset comes back as HTML with
a `200`.

`NotFoundPage` covers this in the browser: a reader, and a crawler that runs
JavaScript, sees a real miss. Two things are still wrong, and neither can be
fixed from a component:

1. A status-only crawler still sees `200`, so it cannot tell a page from a miss.
2. A missing asset returns `200 text/html` instead of `404`, so a broken
   script reference is invisible to anything watching statuses.

The fix is one host rewrite rule. **It has to be a path-shape allowlist, not a
slug allowlist.** This is the part that is easy to get wrong:

- "404 anything that is not a real file" breaks every deep link. The host cannot
  know which slugs exist, so `/story/a-story-published-this-morning` would be a
  404 at the host and never reach the router. SPA fallback is what makes
  `BrowserRouter` work at all, so it cannot be the thing being removed.
- "404 anything outside a list of known slugs" breaks the same link, and needs
  the host to re-sync the list on every publish.

The rule that is correct:

| Request | Response |
| --- | --- |
| `/` | `index.html`, 200 |
| `/assets/<real file>` | the file, 200 |
| `/assets/<missing file>` | **404**, not the app shell |
| `/story/<anything>` | `index.html`, 200 |
| `/auth`, `/dashboard`, `/stories` | `index.html`, 200 |
| anything else | **404**, not the app shell |

`/dashboard` and `/stories` must be in the allowlist even though the app gates
them behind auth. The shell has to load for the router to decide.

Note what this rule does *not* buy: `/story/<a-slug-that-does-not-exist>` still
returns `200`, because the host has no way to know the slug is bad and the story
is fetched client-side. `StoryDetailPage` renders "Story not found" for that
case. Distinguishing it by status would need server-side rendering, which is a
larger change than this issue asks for.

### Status

Not applied. It is host configuration on a Bolt project, it needs a board gate
before a deploy, and it must not ride along with a frontend deploy that gate has
not cleared. `npm run check:host` reports the current state on every run, so
this section can be updated from a measurement rather than a memory.

## Deploy order

No database migration is involved, so there is no database-before-frontend
ordering constraint on this change. Nothing in the app's writes changed.

If a future change ever adds both a migration and frontend code that depends on
it, the migration ships first. PostgREST rejects a whole write whose payload
names a column missing from its schema cache, which fails admin saves silently
while the homepage keeps rendering.