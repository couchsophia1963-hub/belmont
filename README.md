# belmont

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-dq6blzts)

## Which repo is this

This is the canonical Belmont News repository. Three repositories in the
workspace build a "Belmont News" site:

| repo | what it is | status |
| --- | --- | --- |
| `couchsophia1963-hub/belmont` (this one) | React 18 + Vite + Supabase. Has the migrations, the admin panel, the weather panel, and the `App.tsx` route table the story URLs depend on. | canonical |
| `EasySchedule/belmont-news-site` | separate static site, `build.mjs` + `content/`, 7 `node --test` suites. Publishes to GitHub **Pages** and to Netlify. | duplicate, but it is the public front page |
| `EasySchedule/belmont-news` | legacy static front-end, `index.html` + `data/stories.json` | duplicate, archive pending |

If you are about to make a reader-facing change, it goes here. A change made in
either duplicate does not reach the live host.

Two qualifications on "canonical":

1. Canonical for **this app**, which is served only by the Bolt host. Neither
   duplicate can serve it — they render markdown, not the React app.
2. **Not** the front page a reader sees. That is
   `easyschedule.github.io/belmont-news-site`, from a duplicate, on another
   account. "Canonical repo" and "canonical front page" are different things
   here, and conflating them is what produced the stale deploy record BEL-214
   corrected.

## The live host

**Live: <https://belmont-news.bolt.host/>** — served from this repo, `main`. This
is the only host that serves **this** app.

**Dead: `belmont-county-news-b68j.bolt.host`** — that Bolt project is gone. The
host answers `200` but the body is Bolt's own "Website not found" page
(`sentry-transaction=GET /hosting/404`), not this app. A `200` here does not
mean the site is up. Check the `<title>`, not the status code.

### Every host, and which repository publishes it

Corrected 2026-10-05 18:35Z (BEL-214). Earlier revisions of this file named one
live host and stopped there, which is why the deploy record pointed at the wrong
place. There are four hostnames. **Three of them are not this repo.**

| host | status | what it serves | published by |
| --- | --- | --- | --- |
| `belmont-news.bolt.host` | `200` | **this app** — admin panel, weather panel, Supabase stories | out of band, see BEL-308 below |
| `easyschedule.github.io/belmont-news-site` | `200` | the static news site | `EasySchedule/belmont-news-site` via GitHub Pages |
| `belmont-news.netlify.app` | `200` | the same static news site, **now stale** | `EasySchedule/belmont-news-site` via its `netlify.toml` |
| `easyschedule.github.io/belmont-news` | `301` | redirects to itself with a trailing slash; legacy static site | `EasySchedule/belmont-news` (legacy Pages) |
| `couchsophia1963-hub.github.io/belmont/` | `404` | nothing — Pages is not enabled on this repo | — |

The two static hosts render **the same site, not two versions of the newsroom**.
Both build from `EasySchedule/belmont-news-site`, and both pull the markdown from
`EasySchedule/belmont-news-blogs@main` at build time. Both already carry
`<link rel="canonical" href="https://easyschedule.github.io/belmont-news-site/...">`,
so search engines are told the Pages host is the real one. A reader who lands on
Netlify sees the same six stories.

A `404` on the bare `easyschedule.github.io` means only that the account has no
user/org site, which is normal when Pages serves project sites. It is not
evidence that Pages is broken.

### `EasySchedule` is a different GitHub account, not this org

`EasySchedule` is a personal account (`id 104536530`). This repository is not a
fork of anything: `fork: false`, `parent: null`. When you are told "the Belmont
News repo", ask **which** of the three you mean. Two of them are on the other
account and neither is canonical.

### Netlify is bound to `EasySchedule/belmont-news-site`, not to this repo

There is **no `netlify.toml` in this repository** — absent on `main` and a
recursive tree listing contains zero occurrences of "netlify". If you were told
Netlify is bound to *this* repo's `netlify.toml`, that is wrong; the only one in
the workspace is in `EasySchedule/belmont-news-site`.

That is also why the two static hosts agreed for most of 2026-10-05: both run the
same `npm run sync -- --from-github EasySchedule/belmont-news-blogs@main && npm
test && npm run build`.

### The mirror has now stopped rebuilding — measured 2026-10-05 18:36Z

| check | `belmont-news.netlify.app` | Pages |
| --- | --- | --- |
| last build (`generated`) | `16:17:31Z` | `18:30:29Z` |
| `contentHead` | `7879c252…` | `4164531c…` = store `main` |
| `styles.css` | 11,820 bytes | 13,791 bytes |
| store commits behind | **26** | 0 |

Netlify stopped publishing after 16:17Z and has not rebuilt since, while Pages has
published three times since. This is a real origin response, not a CDN artifact:
the response carries `cache-status: fwd=miss`, `age: 0`.

**No reader is missing an edition.** Both hosts still list the same six stories
and both report `posts: 11`. The divergence is in presentation and in the
corrections log: `styles.css` on Pages carries the `caption` and
`.correction-when` rules that Netlify lacks. Netlify is 26 commits behind the
markdown store, so it will serve a stale corrections log and stale styling
indefinitely.

**Consequence: treat `easyschedule.github.io/belmont-news-site` as the newsroom's
public front page and stop handing out `belmont-news.netlify.app`.** It is not a
second source of truth, but it is no longer a faithful mirror, and nothing in this
repository can fix it — the build runs from the other account. See BEL-214.

### Why this repo must not get a Pages site of its own

Enabling Pages here would publish **a third front page for this app** at
`couchsophia1963-hub.github.io/belmont/`, built from a different repository on a
different account, and `deploy-pages.yml` contains **no redirect, no canonical,
and no `301`/`302`** — only `BASE_PATH` and the two Supabase variables. It would
also expose the admin panel on a second public origin. Do not enable it without
deciding the redirect rule first. BEL-214 measured this and recommends against it.

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

## GitHub Pages: prepared, deliberately not switched on

`has_pages` is `false` as of 2026-10-05 18:35Z — the Pages API returns 404 — but
all three prerequisites BEL-204 identified are now in the repository, and enabling
Pages is the only thing left:

1. **`base` in `vite.config.ts`** — done. It reads `BASE_PATH`, defaults to `/`
   for the Bolt host, and the Pages workflow sets `/belmont/`.
2. **`public/404.html`** — done. It remembers the requested path and hands it to
   the router via `src/main.tsx`, so `/story/<slug>` reaches the story on Pages
   the way it already does on the Bolt host.
3. **A deploy workflow and the build variables** — the workflow exists and is
   merged; the variables do not. This repository has no Actions secrets set.

### The gate is now firing on `main` — expected, do not "fix" it

PR #28 merged, so `deploy-pages.yml` runs on every push to `main`. It currently
**fails on every push**, and that is the gate working:

```
2026-10-05T18:27:39Z Require the Supabase build variables
  VITE_SUPABASE_URL project  unrecognised
  anon key fingerprint        none (not set)
  error: VITE_SUPABASE_URL is not set.
  error: VITE_SUPABASE_ANON_KEY is not set.
  RESULT: fail -- this build must not publish an artifact
```

Run `37355445602`, on `main` at `6e54bc88`. The red run is the intended outcome
while the secrets are absent: it publishes no artifact, so no half-configured app
can reach a public URL.

Two ways to stop the noise, in order of preference:

1. **Recommended:** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as
   Actions secrets, decide the redirect rule first (see above), then enable
   Pages. The run goes green on the next push.
2. If neither is happening soon, disable or gate the workflow so `main` is not
   permanently red. Do **not** delete the build-env gate to make it green — the
   gate is what stops a broken app from being published.

`src/lib/storyUrl.ts` already derives its base from the runtime pathname via
`siteBasePath()`, so the app code is ready for a subdirectory deploy.

The anon key is publishable by design — it is the RLS-facing key and RLS is
what protects the data. It still belongs in the secret store or GitHub Actions
secrets, never in this repository. The `service_role` key is never publishable
under any circumstances.
