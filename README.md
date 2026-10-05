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

## Checks

| Command | What it does |
| --- | --- |
| `npm run check:authz` | Fails if the code disagrees with the written answer to "who is allowed to do what" ([docs/api-authorization.md](docs/api-authorization.md)), or if a mutating action has no row in that table. Needs no install and no database. |
| `npm run authz:doc` | Regenerates [docs/api-authorization.md](docs/api-authorization.md) from [scripts/api-authorization-spec.mjs](scripts/api-authorization-spec.mjs). Run this after changing the spec, never edit the table by hand. |

`check:authz` also runs in CI on every pull request and on pushes to `main`.

A row has to name the surfaces that can enforce it. Two are code and one is not:

- the edge function, `supabase/functions/api/index.ts`, authenticated by a `bcn_` key
  and running as service role, so it bypasses RLS entirely — the only gate on that path
  is an `if` in TypeScript
- PostgREST, running as `authenticated`, where RLS is the only gate
- a trigger, which fires for every caller of a table including the ones RLS already
  admitted, and which RLS cannot see

A guard on one is not visible to the others.

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

### Who rebuilds the live host: nobody in this repo (BEL-308)

**The trigger that rebuilds `belmont-news.bolt.host` is out of band. There is no
workflow, hook, or schedule in this repository that builds or deploys it, and
there is no `netlify.toml`.** Bolt builds it from its own environment when
someone uses Bolt's own deploy path.

Checked on 2026-10-05 against the repository, not inferred:

| where a build variable could come from | state |
| --- | --- |
| a workflow that deploys the Bolt host | does not exist |
| `netlify.toml` | does not exist |
| Actions secrets on this repo | none set (empty list) |
| Actions variables on this repo | none set (empty list) |
| GitHub environments | none |
| a tracked `.env` | none; `.env.example` holds names only |

So the two variables that every read of the live app depends on are supplied by
whatever builds it inside Bolt, and this repository neither holds nor validates
them. Two consequences, and they are the reason a reader-facing fix on this
surface cannot be given a delivery date:

1. **A rebuild cannot be requested, scheduled, or predicted from here.** It is a
   coincidence. Do not promise one.
2. **Nothing in this repo would notice a bad pair before it shipped.** A build
   with those two variables absent, wrong, mis-paired, expired, or carrying a
   `service_role` key all succeed, and the shell still renders. A green build was
   never evidence of a working build.

`npm run build-env` now refuses the second case. See below.

### The build-env gate (BEL-308)

```bash
npm run build-env          # shape and provenance, no network
npm run build-env:probe    # additionally read from the project with the key
```

`npm run build` runs the first automatically via `prebuild`, so a build that
cannot work does not produce a `dist/`.

It rejects what `vite build` accepts: absent variables, a non-JWT, a
`service_role` key, an expired key, and a key issued for a project other than
the one `VITE_SUPABASE_URL` names (the BEL-82 mis-pairing). `--probe` additionally
requires a `200` on `stories` and `weather_forecasts`, which is the only thing
that distinguishes a revoked key from a working one — a key can be well formed,
unexpired, `anon`, and issued for the right project and still be refused.

Both modes report a key by `sha256[:12]` fingerprint, project ref, role, and
expiry. No mode ever prints a key value, so gate output is safe to paste into a
ticket.

Until Actions secrets exist on this repo, the Pages deploy fails at this gate.
That is the correct outcome and it is earlier and more specific than the build
failing: it names the missing variables instead of shipping a site that cannot
read.

For a local build, copy `.env.example` to `.env` and fill in the two names. The
gate then passes and `npm run build` proceeds. This is a deliberate cost: the
alternative is a build that succeeds and produces an artifact nobody can use.

`npm run dev` is unaffected — there is no `predev`, so Vite starts either way. A
missing pair there is a client-side throw at module load, which means the dev
server answers `200` with the page shell and the error only appears in the
browser console. Worth knowing when triaging: a `200` from `localhost` says
nothing about the env.

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

## GitHub Pages is prepared but not switched on

`has_pages` is `false` as of 2026-10-05 — the Pages API returns 404 — but all
three prerequisites BEL-204 identified are now in the repository, and enabling
Pages is the only thing left:

1. **`base` in `vite.config.ts`** — done. It reads `BASE_PATH`, defaults to `/`
   for the Bolt host, and the Pages workflow sets `/belmont/`.
2. **`public/404.html`** — done. It remembers the requested path and hands it to
   the router via `src/main.tsx`, so `/story/<slug>` reaches the story on Pages
   the way it already does on the Bolt host.
3. **A deploy workflow and the build variables** — the workflow exists; the
   variables do not. This repository has no Actions secrets set, so
   `deploy-pages.yml` halts at the build-env gate rather than publishing a site
   that cannot read.

Enabling Pages is a separate, explicit step, and merging the workflow does not do
it. Do not enable it until the secrets exist, or the first deploy is the failure
this gate was added to prevent.

`src/lib/storyUrl.ts` already derives its base from the runtime pathname via
`siteBasePath()`, so the app code is ready for a subdirectory deploy.

The anon key is publishable by design — it is the RLS-facing key and RLS is
what protects the data. It still belongs in the secret store or GitHub Actions
secrets, never in this repository. The `service_role` key is never publishable
under any circumstances.
