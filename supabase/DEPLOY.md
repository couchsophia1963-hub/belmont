# Deploying to `hocwwzzawiwkxghvfasg`

There is no CI in this repository and there never has been. This file is the
deploy procedure, written down so it stops depending on one person remembering
the dashboard.

Read the whole file once before the first push. The first push is the only
dangerous one: after it, every deploy is boring.

## The commands

Three, not two. In this order.

```bash
# 0. Once per machine. Needs SUPABASE_ACCESS_TOKEN in the environment.
supabase link --project-ref hocwwzzawiwkxghvfasg

# 1. See what would happen. Read the output before running step 2.
supabase db push --dry-run

# 2. Apply migrations. Schema first. Always.
supabase db push

# 3. Apply the edge function. Only after step 2 has landed.
supabase functions deploy api --project-ref hocwwzzawiwkxghvfasg
```

`project_id` in `config.toml` does **not** replace step 0. On CLI 2.119.0 the
project ref for `db push` is read from `supabase/.temp/project-ref`, which step 0
writes, or from `--project-ref`. With `project_id` present in `config.toml` and
no link, `db push` still answers `Cannot find project ref`.

## The one credential

`SUPABASE_ACCESS_TOKEN`, a Supabase personal access token (`sbp_...`).

It lives in Paperclip's secret store. Not in this repository, not in an issue, not
in a comment, not in a log, not in a chat message. If you need to rotate it or you
are not sure where it is, ask for it to be re-proposed as a secret.

It is a personal access token, not a `service_role` key. The difference matters:
the PAT is what lets the CLI resolve the project and reach the Management API. The
`service_role` key bypasses RLS and is not a substitute for anything here.

Everything below step 0 needs it. Without it the CLI stops at
`Access token not provided`.

### It is also the SQL route

This is the part that makes the rest of this file enforceable rather than
advisory. The same token gives a real SQL connection to the project, through the
Management API, with no Postgres password involved:

```bash
supabase db query --linked "select version, name from supabase_migrations.schema_migrations order by version"
```

`--linked` resolves the project from the link step. `db query` also takes
`--project-ref`, and `--file` to run a whole `.sql` file.

That means the grants check, the `pg_policies` check, the icon pre-check and the
post-push verification in this document are all runnable by the person doing the
deploy, against the live project, with a result nobody has to transcribe into a
chat thread. Run them here rather than asking someone to paste output back.

Note what it is not: `db query` is for reading and for verification. Applying DDL
goes through `db push` or `migration repair`, which is the ordering this file is
built around.

## Step 1, before anything: reconcile `schema_migrations`

The migrations in this directory may have been applied by hand through the
dashboard SQL editor. If they were, they are **not** in
`supabase_migrations.schema_migrations`, and `db push` will try to replay all of
them from the top.

Run this against the live project and read the result:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

Compare it against the files in this directory. **Match on `version`, not on
`name`.** Two of the files have a doubled `.sql.sql` extension and a name that
embeds a different timestamp from their version prefix, so a name-based
comparison will show two false mismatches:

| file | version prefix |
| --- | --- |
| `20261004123918_create_belmont_news_schema.sql` | `20261004123918` |
| `20261005115049_20261005170000_stories_writer_select_all.sql.sql` | `20261005115049` |
| `20261005123424_20261005180000_story_locking.sql.sql` | `20261005123424` |
| `20261005140000_weather_forecasts_deferred_fields.sql` | `20261005140000` |
| `20261005150000_author_profiles_fk.sql` | `20261005150000` |
| `20261005160000_comments_public_view.sql` | `20261005160000` |
| `20261005170000_weather_forecasts_admin_delete.sql` | `20261005170000` |
| `20261005203000_stories_admin_delete_published_guard.sql` (PR #15, not on `main` yet) | `20261005203000` |

**Watch out for one collision.** `20261005170000` is now a real *version* — the
weather delete policy — and it is also the string embedded in the *name* of
`20261005115049_20261005170000_stories_writer_select_all.sql.sql`. Reading the
`name` column of `schema_migrations` gives you a row that reads
`20261005170000_stories_writer_select_all.sql`, which looks like the weather
migration and is not. This is the concrete version of the caution above, and it is
why `supabase migration list` comparing timestamps only is a relief rather than a
limitation.

Do not rename the two odd files. A migration that has been applied has a history
tied to its filename, and renaming it desynchronises that. They are ugly; they
are also load-bearing.

If a version is missing from the table, do not assume it needs replaying. Check
whether its effect is already on the project — see the audit below — and then
decide per file whether to replay it or mark it as applied.

Mark it as applied with `migration repair`, not with hand-written SQL. It is the
supported command, it takes several versions at once, and it is what the CLI's own
comparison is built around:

```bash
supabase migration repair --linked --status applied \
  20261004123918 20261005115049 20261005123424
```

`--status applied` inserts a history row without running the migration.
`--status reverted` deletes one. Repairing a version that was never applied is the
easy way to make `db push` skip work the schema still needs, so only do it for a
file whose effect you have confirmed is already live.

This is a person's decision made after reading the audit. Do not let the CLI make
it by guessing.

`supabase migration list` is the read side and prints local against remote:

```bash
supabase migration list --linked
```

It compares **timestamps only**, never names. That is the CLI's own behaviour, not
a shortcut, and it is why the version prefixes above are the thing to match on.

The reverse case is the quieter one. If a version **is** recorded but its effect
was later hand-patched in the dashboard, `db push` will never touch it and the
hand-patch will outlive the file that describes the schema. There is no way to
detect that from the migrations table. It is a reason to read the audit below
once, by hand, and know what the schema is supposed to be.

## Step 2: replay audit

Every migration in this directory, audited for what happens if it runs against a
project that already has the schema. This was the open question in BEL-180 and it
is answered here.

**This audit has a shelf life.** Migrations are being merged into `main` while
this file is open for review. It was accurate against `main` at `63f543c`, seven
files, and `20261005170000` arrived after it was written. **Re-run the file list
before you trust the table** — `ls supabase/migrations/` is the authority, and the
three-command preflight below catches anything that arrived since.

**Summary: replay-tolerant in form, all of them. Two can still fail on live data.
One can leave the project in a worse state than not pushing at all. One could not
be replayed at all until PR #27.**

| # | file | verdict |
| --- | --- | --- |
| 1 | `20261004123918_create_belmont_news_schema` | tolerant, but re-creates two looser policies |
| 2 | `20261005115049_..._stories_writer_select_all` | tolerant, trivially |
| 3 | `20261005123424_..._story_locking` | tolerant, trivially |
| 4 | `20261005140000_weather_forecasts_deferred_fields` | **can fail** on the icon constraint |
| 5 | `20261005150000_author_profiles_fk` | **can fail** on orphan rows |
| 6 | `20261005160000_comments_public_view` | tolerant; probably never applied |
| 7 | `20261005170000_weather_forecasts_admin_delete` | **was not replayable** — fixed in PR #27 |
| 8 | `20261005203000_..._published_guard` (PR #15) | tolerant; its post-check needs a rollback |

### 1. `20261004123918_create_belmont_news_schema.sql`

Tolerant. `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, and `DROP POLICY IF EXISTS` + `CREATE POLICY`
throughout.

The seed data is safe to replay and worth being precise about why: both inserts
are `ON CONFLICT DO NOTHING`, keyed on `slug` and `forecast_date`. If an editor
has corrected the wording of a seeded story, a replay does **not** overwrite it.
There is no path by which replaying this file damages content.

The one statement that needs rights this file does not have to ask about is
`DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users` followed by
`CREATE TRIGGER`. That is DDL on a table in the `auth` schema. `db push`
connects as `postgres`, which can do it. Any other route needs to be checked
first.

**The thing to know about this file:** it re-creates `stories_admin_delete`
without the `locked` guard, and it re-creates `comments_public_read`. Files 3, 6
and 7 repair both later in the same push. So the end state is correct only if the
whole push gets far enough.

A push that fails later does not leave this file's state intact — file 3 has
already restored the `locked` guard by then. What it does leave is
`comments_public_read`, because file 6 is the only thing that closes it. Read
hazard A.

### 2. `20261005115049_..._stories_writer_select_all.sql.sql`

Tolerant. `DROP POLICY IF EXISTS` + `CREATE POLICY`, nothing else. No columns, no
grants, no data.

### 3. `20261005123424_..._story_locking.sql.sql`

Tolerant. Two `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and one
`DROP POLICY IF EXISTS` + `CREATE POLICY`.

### 4. `20261005140000_weather_forecasts_deferred_fields.sql`

Tolerant in form, and **this is the most likely file to fail a first push.**

Six `add column if not exists` are no-ops if the columns are there. Every
constraint is dropped before it is re-added, so re-adding is safe. All of that
is fine.

The failure is here:

```sql
alter table public.weather_forecasts
  add constraint weather_forecasts_icon_check
  check (icon in ('sun','cloud','cloud-sun','cloud-rain','cloud-snow','cloud-lightning','cloud-fog'))
  not valid;
alter table public.weather_forecasts validate constraint weather_forecasts_icon_check;
```

`validate constraint` scans every live row. The constraint has no `NULL` branch
because `icon` is `NOT NULL` in the base schema, so a single row holding a value
outside those seven codes aborts the file. The seven codes are exactly the
client's `ICON_MAP` in `src/components/WeatherForecast.tsx`.

This is not hypothetical. It is the failure BEL-14 found: an NWS icon URL was
published into `icon`, the client resolved it to the sun glyph, and the row read
`"Sunny"` forever with no error anywhere. The file's own header asserts "All three
rows already satisfy it", which is a claim about the live project made without a
SQL route to confirm it. **Check it before the first push:**

```sql
select id, forecast_date, icon from public.weather_forecasts
 where icon not in ('sun','cloud','cloud-sun','cloud-rain','cloud-snow','cloud-lightning','cloud-fog');
```

Zero rows means the push is safe. Any rows means the weather publish wrote
something the schema decision says it cannot, which is a data bug to fix
separately, and the migration cannot be applied until it is fixed. Do not widen
the constraint to make the push succeed.

This file also has its grants section entirely commented out. See step 4.

### 5. `20261005150000_author_profiles_fk.sql`

Tolerant **if the constraints already exist**. Both are guarded by
`IF NOT EXISTS (select 1 from pg_constraint where conname = ...)`, so a replay
skips them.

If they do **not** exist and any row is orphaned, the file aborts. The header
documents the pre-check:

```sql
select s.id, s.slug, s.author_id
  from stories s left join profiles p on p.id = s.author_id
 where s.author_id is not null and p.id is null;

select c.id, c.user_id
  from comments c left join profiles p on p.id = c.user_id
 where p.id is null;
```

Both must return zero rows.

Note the lock this file takes. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`
on a populated table takes `ACCESS EXCLUSIVE` and validates every row while
holding it, which blocks writes for the duration. On seven stories that is
milliseconds. It is still a write block, so do not run it unattended while an
editor is saving.

### 6. `20261005160000_comments_public_view.sql`

Tolerant. `DROP VIEW IF EXISTS` + `CREATE VIEW`, so a view left with
`security_invoker = on` by an earlier attempt is corrected rather than skipped.
`DROP POLICY IF EXISTS` + `CREATE POLICY` for the policy swap. The one
`GRANT`/`REVOKE` pair is idempotent.

**This file has probably never been applied to this project.** Its header says so:
the Supabase tool connection in this company is bound to the Shipwright project,
which has no `comments` table and no `profiles` table, so the transaction aborts
with `42P01` and rolls back. Every attempt would have failed the same way.

If that is right, then two things are true at once, and the second is not a
bookkeeping detail:

- The version is missing from `supabase_migrations`, so `db push` will replay it.
  Fine, it is tolerant.
- **`comments_public_read` is still live on the site.** That policy is
  `TO anon, authenticated USING (true)` on the `comments` table. The table is
  empty, so nothing leaks *yet*. The moment one reader comments, every comment
  body and every commenter `user_id` is readable with the public anon key.

Confirm it before anything else in this file:

```sql
select policyname, cmd, roles from pg_policies
 where schemaname = 'public' and tablename = 'comments'
 order by policyname;
```

If `comments_public_read` is there and `comments_public` does not exist, the
exposure is live right now and this migration is the fix. That is worth doing
before the rest of this procedure, as its own change, rather than bundled into a
first push that also touches four other tables.

### 7. `20261005170000_weather_forecasts_admin_delete.sql`

**This one could not be replayed.** Fixed in
[PR #27](https://github.com/couchsophia1963-hub/belmont/pull/27); the notes below
describe it as it stood on `main` at `63f543c`, because the failure mode is the
point.

The file drops `weather_writer_delete` and creates `weather_admin_delete`. It never
drops `weather_admin_delete`. So a second run fails:

```
ERROR:  policy "weather_admin_delete" for table "weather_forecasts" already exists
SQLSTATE 42710
```

Every other `CREATE POLICY` in this directory is preceded by a
`DROP POLICY IF EXISTS` carrying the same name. This file was the only one of the
seven on `main` that was not, which is why it reads as a deviation rather than a
choice.

Why that mattered: BEL-180's scenario is a **replay**, because these migrations
were largely applied by hand and are therefore not recorded. This file was the one
that would have stopped the replay, and `20261005170000` sorts last, so it was the
final file to abort — after six had committed. Nothing dangerous is stranded in
that particular case, because file 6 closes `comments_public_read` and file 6 has
already run by then. But the push fails, and BEL-180's acceptance is that
`db push --dry-run` runs clean.

The fix is one line and is `IF EXISTS`, so it is inert on a project where the
policy has never been created.

### 8. `20261005203000_stories_admin_delete_published_guard.sql` (PR #15)

Not on `main` yet. Tolerant: `DROP POLICY IF EXISTS` + `CREATE POLICY`, and it
creates no column and grants nothing to any role, so it cannot reopen the BEL-15
grants question.

Its post-check is the problem, and it is the reason this file is here rather than
in PR #15. As written, the post-check instructs the reader to run a **real
`DELETE` against a live story on the production site** and expect `0 rows`. That
is a genuine destructive request aimed at production, written as a verification
step, and it relies entirely on the reader noticing it is supposed to be refused.

Verification must not be able to delete a story.

The real check is read-only and role-independent. Run it first:

```sql
select policyname, cmd, qual from pg_policies
 where schemaname = 'public' and tablename = 'stories'
   and policyname = 'stories_admin_delete';
-- qual must contain both 'locked' and 'published'
```

Then the behavioural check, which has one trap: **run it through PostgREST, not as
`postgres`.** A SQL `DELETE` issued as `postgres` bypasses RLS entirely, so the
policy would not be consulted, the row really would go, and "expect 0 rows" would
be wrong. The rollback would be the only thing standing between the check and a
deleted story.

The path that actually exercises the guard is the admin's own session, which is
also the path `StoryManagerPage.tsx` uses:

```
DELETE /rest/v1/stories?id=eq.<a live published story id>
  -> 204 with Content-Range: */0
```

That is `StoryManagerPage.tsx:169`, and it is the second of the two delete paths
this migration closes. The edge function's path is guarded by the function's own
check, not by this policy, because its client is built with the service role key.

If you must exercise the policy from SQL, do it inside a transaction that cannot
commit, and accept that you are testing `postgres`'s bypass rather than the
policy:

```sql
begin;
  delete from public.stories
   where id = (select id from public.stories where published = true limit 1);
  select count(*) as still_there from public.stories
   where published = true;
rollback;
```

The `rollback` has to be typed. Do not assume it happened.

## Hazard A: a push is not atomic across files

`supabase db push` applies **each migration file in its own transaction**. The
CLI does not wrap the whole push in one. Atomicity is per file.

That means a push that fails part-way leaves every earlier file committed **and
recorded**, and that is inherent to the CLI. No change to these files prevents it.

The concrete case, because it matters for this repository. If `db push` fails at
file 4:

- Files 1, 2 and 3 are committed and recorded.
- File 3 has already re-created `stories_admin_delete` **with** the `locked`
  guard, so the delete guard survives.
- File 6 never ran, so **`comments_public_read` is live.** File 1 re-created it
  and nothing closed it.

So the delete policy is fine and the comments exposure is back. That asymmetry is
the thing to remember, because the delete policy is the one you would think to
check.

This is the rule-5 failure. A blind retry re-runs against a half-applied project
and nobody can say what state it is in.

### What actually reduces the risk

Not editing the migrations. Shrinking what the push has to do:

1. **Reconcile first.** Every file whose effect is already live gets
   `migration repair --status applied`. `db push` then applies only the files that
   genuinely are missing. If five of six are already applied, a failure touches one
   file instead of six.
2. **Close the comments exposure in its own push.** Once files 1 to 3 are recorded,
   a push that only contains `20261005160000` either applies it or does not. There
   is no window where it half-landed.
3. **Push the icon-bearing file last**, after the pre-check in its audit entry
   returns zero rows. It is the file most likely to fail.

### The bare `begin;` / `commit;` — leave them

Four of the seven files wrap their body in a bare `begin;` / `commit;`. Under
`db push` these are close to inert: the `begin;` warns and does nothing, and the
`commit;` is the last statement in each file, so it commits at roughly the point
the CLI would commit anyway.

An earlier version of this document recommended removing them, on the theory that
`db push` wraps the whole push in one transaction and that the bare `commit;`
truncated it. **That theory was wrong**, and the recommendation is withdrawn.

Removing them would also cost something. These files are also the ones a person
pastes into the dashboard SQL editor when there is no token, and in that path the
`begin;` / `commit;` is the only thing making the file atomic. Trading real
atomicity in the fallback path for nothing in the `db push` path is a bad trade.

Leave them. If a future file needs to be appended to after its `commit;`, that is
the moment to care.

## Hazard B: do not widen a grant to make a write succeed

This is the rule-3 check and it is the one that has never been run, because
there has never been a SQL route.

Read the grants before applying any migration that adds a column:

```sql
select
  (select count(*) > 0
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'weather_forecasts'
      and grantee = 'authenticated' and privilege_type = 'UPDATE')
    as update_is_table_level,
  (select coalesce(string_agg(column_name, ', ' order by column_name), '(none)')
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'weather_forecasts'
      and grantee = 'authenticated' and privilege_type = 'UPDATE')
    as update_columns,
  (select count(*)
     from pg_attribute
    where attrelid = 'public.weather_forecasts'::regclass
      and attnum > 0 and not attisdropped and attacl is not null)
    as columns_with_explicit_acl;
```

- **`update_is_table_level = true` and `columns_with_explicit_acl = 0`** — its grants
  are table-level, which is the Supabase default, and they already cover the six
  columns file 4 adds. Do nothing.
- **`update_is_table_level = false`** — its grants are column-scoped. Extend them in
  the same change as the migration, not as a follow-up. Grant `SELECT` as well as the
  writes.

**Do not count rows in `information_schema.column_privileges` for this.** Its first
UNION branch explodes the *table* ACL and pairs it with every column, so a table-level
grant is reported once per column, and the table owner appears with implicit privileges
whether or not anything was ever granted. That view returns rows on a Supabase project
with nothing column-scoped. An earlier revision of this section used it and told the
reader that no rows meant table-level and rows meant stop; on a real PostgreSQL engine it
returns rows for the default arrangement, so it reported stop on the correct case.
`pg_attribute.attacl` is the real detector — it is NULL unless a column carries its own
ACL — and it was checked in both directions: NULL on every column under table-level
grants, and exactly the named columns after `UPDATE` was revoked and re-granted per
column.

`20261005140000` has its grant statements commented out on purpose, because
which privileges a role needs is a person's call made after reading that check.
That reasoning is sound. The gap is that the check has never been run against the real
database, so file 4 may be adding six columns that `authenticated` cannot write.

Why `SELECT` is not optional alongside the writes: PostgREST expands `select=*`
to only the columns the calling role may read, and the admin panel loads the
table with `.select('*')`. Give `authenticated` the writes but not the read, and
every save succeeds while the new fields read back empty. The editor types a
value, presses Save, sees no error, and loses it on the next load.

After any migration that adds a column, confirm the anonymous read still works.
These are the same two variables `src/lib/supabase.ts` reads, so use the same
values the deployed site uses:

```bash
curl -s "$VITE_SUPABASE_URL/rest/v1/weather_forecasts?select=forecast_date,precipitation_chance&limit=1" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY"
```

`precipitation_chance` appearing in the returned key set means the anon grant
covers the new column. If the key is missing, the anon grant is column-scoped and
the strip will render those four fields as absent rather than as an error.

## Deploy order

Schema before anything that names it. PostgREST rejects an entire write whose
payload names a column absent from its schema cache, so a frontend that lands
first breaks admin saves silently while the homepage keeps rendering. It looks
healthy until an editor touches the weather panel.

For a change that includes both a migration and code:

1. `supabase db push` — the migration.
2. Confirm the PostgREST schema cache picked it up. `NOTIFY pgrst, 'reload schema'`
   if the read does not reflect the new column.
3. Run the grants check from hazard B.
4. Deploy the frontend or the edge function.
5. Verify.

For the BEL-71 delete guard specifically, the migration is the schema half and
the function change is in `supabase/functions/api/index.ts`. The migration first.
The function's Supabase client is built with the service role key and bypasses
RLS, so on the API path `stories_admin_delete` is not consulted at all — it
guards the direct PostgREST path that `StoryManagerPage.tsx` uses. The two layers
have to agree, and the guard is worthless if it lands after the thing it guards.

## If a push fails

Do not re-run it to see what happens.

1. Read the error. If it is `23505`, `42P01`, or a constraint name, it is one of
   the two audited failures above and it is a data question, not a retry.
2. Find out what is actually applied. Do not infer it from the CLI's last line:

```bash
supabase migration list --linked
```

3. Check the policies directly. Because a push is atomic per file and not across
   files, a failure at file 4 leaves `comments_public_read` live while the
   `locked` guard on `stories_admin_delete` survives:

```bash
supabase db query --linked "select tablename, policyname, cmd, qual from pg_policies
  where schemaname = 'public' and tablename in ('stories','comments')
  order by tablename, policyname"
```

4. Repair deliberately, then push again. Use `migration repair` for the history
   table, never a hand-written `insert`.

## What is not here

- **CI.** There is no `.github` directory and no workflow. These commands are run
  by hand and this file is the procedure. Wiring them into CI needs a runner with
  the token available as a secret, which is a separate piece of work.
- **Rollback.** `db push` has no down-migrations, by design. Reversing a bad
  migration is a new forward migration. If that matters enough to change, say so.
- **The `service_role` key.** It is in the secret store and is not needed for any
  step here.