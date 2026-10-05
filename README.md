# belmont

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-dq6blzts)

## Which repo is this

This is the canonical Belmont News repository. Three repositories in the
workspace build a "Belmont News" site:

| repo | what it is | status |
| --- | --- | --- |
| `couchsophia1963-hub/belmont` (this one) | React 18 + Vite + Supabase. Has the migrations, the admin panel, the weather panel, and the `App.tsx` route table the story URLs depend on. | canonical |
| `EasySchedule/belmont-news` | legacy static front-end, `index.html` + `data/stories.json` | duplicate, archive pending |
| `EasySchedule/belmont-news-site` | separate static site, `build.mjs` + `content/`, 7 `node --test` suites | duplicate, archive pending |

If you are about to make a reader-facing change, it goes here. A change made in
either duplicate does not reach the live host.

## The live host

**Live: <https://belmont-news.bolt.host/>** — served from this repo, `main`.

**Dead: `belmont-county-news-b68j.bolt.host`** — that Bolt project is gone. The
host answers `200` but the body is Bolt's own "Website not found" page
(`sentry-transaction=GET /hosting/404`), not this app. A `200` here does not
mean the site is up. Check the `<title>`, not the status code.

Verified on 2026-10-05 by building `main` and comparing it to what the host
serves. The CSS bundle the host returns is byte-identical to a local build of
`main` (`index-BMkWqqDc.css`), and the newest feature on `main` (the weather
panel collapse) is present in the host's JS bundle.

The JS bundle hash will not match a local build, and that is expected:
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are inlined at build time, so a
build without them differs.

### Two repos claim the live host

`EasySchedule/belmont-news` states in its README that it is "published hourly
to https://belmont-news.bolt.host/". That host serves **this** repo, not that
one. A description being accurate is not evidence the deploy was right — see
BEL-141 and BEL-204.

## Deploy order

**Database first, then the frontend. Always.**

PostgREST rejects an entire write whose payload names a column that is missing
from its schema cache. A frontend-first deploy breaks admin saves silently while
the homepage keeps rendering fine, so it looks healthy right up until an editor
touches the weather panel.

Before any migration, read the grants:

```sql
select column_name, grantee
from information_schema.column_privileges
where table_name = '<table>';
```

If that returns rows, grants are column-scoped and a new column needs the grant
extending, or every write fails after the migration lands. Do not widen a grant
to `anon` on an assumption — read it, then decide.

The per-migration replay audit is in `supabase/DEPLOY.md` (PR #21). It is
required reading before the first `db push`.

## GitHub Pages is not enabled on this repo

`has_pages` is `false` and there is no `.github/workflows/`. Standing it up is
not a config toggle — `BrowserRouter` (BEL-92) means the host must serve
`index.html` for unknown paths, and three things are missing today:

1. **`base` in `vite.config.ts`.** Assets are emitted as `/assets/...`. A Pages
   project site is served from `/<repo>/`, so every asset 404s. Needs
   `base: '/belmont/'` (or `/` with a custom domain).
2. **`public/404.html`.** GitHub Pages serves its own 404 for unknown paths and
   does not fall back to `index.html`, so `/story/<slug>` deep links break. A
   404 redirect shim is required.
3. **A deploy workflow**, plus `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` in the build environment.

`src/lib/storyUrl.ts` already derives its base from the runtime pathname via
`siteBasePath()`, so the app code is ready for a subdirectory deploy. The asset
`base` and the 404 fallback are what are missing.

The anon key is publishable by design — it is the RLS-facing key and RLS is
what protects the data. It still belongs in the secret store or GitHub Actions
secrets, never in this repository. The `service_role` key is never publishable
under any circumstances.
