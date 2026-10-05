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
| `20261005203000_stories_admin_delete_published_guard.sql` (PR #15, not on `main` yet) | `20261005203000` |

Do not rename the two odd files. A migration that has been applied has a history
tied to its filename, and renaming it desynchronises that. They are ugly; they
are also load-bearing.

If a version is missing from the table, do not assume it needs replaying. Check
whether its effect is already on the project — see the audit below — and then
decide per file whether to replay it or mark it as applied:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20261005150000', 'author_profiles_fk');
```

Only do that for a file whose effect you have confirmed is already live. This is
the reconciliation step, and it is a person's decision made after reading the
audit. Do not let the CLI make it by guessing.

The reverse case is the quieter one. If a version **is** recorded but its effect
was later hand-patched in the dashboard, `db push` will never touch it and the
hand-patch will outlive the file that describes the schema. There is no way to
detect that from the migrations table. It is a reason to read the audit below
once, by hand, and know what the schema is supposed to be.

## Step 2: replay audit

Every migration in this directory, audited for what happens if it runs against a
project that already has the schema. This was the open question in BEL-180 and it
is answered here.

**Summary: all seven are replay-tolerant in form. Two can still fail, and one can
leave the project in a worse state than not pushing at all.**

| # | file | verdict |
| --- | --- | --- |
| 1 | `20261004123918_create_belmont_news_schema` | tolerant, but re-creates two looser policies |
| 2 | `20261005115049_..._stories_writer_select_all` | tolerant, trivially |
| 3 | `20261005123424_..._story_locking` | tolerant, trivially |
| 4 | `20261005140000_weather_forecasts_deferred_fields` | **can fail** on the icon constraint |
| 5 | `20261005150000_author_profiles_fk` | **can fail** on orphan rows |
| 6 | `20261005160000_comments_public_view` | tolerant; probably never applied |
| 7 | `20261005203000_..._published_guard` (PR #15) | tolerant; its post-check needs a rollback |

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
and 7 repair both later in the same push. So the end state is correct **only if
the whole push completes.** If the push stops after file 1, the project is left
with a delete policy that ignores `locked` and a comments table readable by
`anon`. Read hazard A before running the first push.

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

### 7. `20261005203000_stories_admin_delete_published_guard.sql` (PR #15)

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

## Hazard A: four migrations open their own transaction

Four of the seven files contain a bare `begin;` and `commit;` around their body:

- `20261005140000_weather_forecasts_deferred_fields.sql`
- `20261005150000_author_profiles_fk.sql`
- `20261005160000_comments_public_view.sql`
- `20261005203000_stories_admin_delete_published_guard.sql`

`supabase db push` runs the push in its own transaction. A `commit;` inside a
migration ends that transaction early. The consequence is not theoretical: if
file 4 fails its icon validation, files 1 through 3 are already committed **and
recorded**, and the project is left exactly in the state file 1 creates — a delete
policy that ignores `locked`, and `comments_public_read` restored.

That is the rule-5 failure with extra steps. A blind retry then re-runs against a
half-applied project and nobody can say what state it is in.

**Before the first push, remove the `begin;` and `commit;` lines from those four
files.** Under `db push` they are a no-op — the CLI already provides the
transaction — and removing them restores push-level atomicity. Nothing else in
the files depends on them.

The one exception is the rollback-wrapped post-check above, if you move it into
the file. That `begin;`/`rollback;` pair is deliberate and belongs inside its own
transaction, not around the migration body.

## Hazard B: do not widen a grant to make a write succeed

This is the rule-3 check and it is the one that has never been run, because
there has never been a SQL route.

Read the grants before applying any migration that adds a column:

```sql
select grantee, privilege_type, count(*)
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'weather_forecasts'
 group by 1, 2 order by 1, 2;
```

- **No rows for `authenticated`** — its grants are table-level, which is the
  Supabase default, and they already cover the six columns file 4 adds. Do
  nothing.
- **Rows for `authenticated`** — its grants are column-scoped. Extend them in the
  same change as the migration, not as a follow-up. Grant `SELECT` as well as the
  writes.

`20261005140000` has its grant statements commented out on purpose, because
which privileges a role needs is a person's call made after reading that check.
That reasoning is sound. The gap is that the check has never been run, so file 4
may be adding six columns that `authenticated` cannot write.

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

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

3. Check the policies directly, because hazard A means a failed push may have left
   file 1's looser policies in place:

```sql
select tablename, policyname, cmd, qual from pg_policies
 where schemaname = 'public'
   and tablename in ('stories', 'comments')
 order by tablename, policyname;
```

4. Repair deliberately, then push again.

## What is not here

- **CI.** There is no `.github` directory and no workflow. These commands are run
  by hand and this file is the procedure. Wiring them into CI needs a runner with
  the token available as a secret, which is a separate piece of work.
- **Rollback.** `db push` has no down-migrations, by design. Reversing a bad
  migration is a new forward migration. If that matters enough to change, say so.
- **The `service_role` key.** It is in the secret store and is not needed for any
  step here.