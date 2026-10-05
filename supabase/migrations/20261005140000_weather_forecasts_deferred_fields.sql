-- ============================================================
-- weather_forecasts: deferred fields from the BEL-12 schema decision
--
-- Issue:  BEL-15
-- Adds the four fields the schema decision knowingly did not publish
-- (precipitation_chance, sunrise, sunset, and wind direction + range)
-- and enforces the `icon` value contract that BEL-14 found unenforced.
--
-- Base schema reference: 20261004123918_create_belmont_news_schema.sql
--   id              uuid        PRIMARY KEY DEFAULT gen_random_uuid()
--   forecast_date   date        NOT NULL UNIQUE
--   high_temp       integer     NOT NULL
--   low_temp        integer     NOT NULL
--   condition       text        NOT NULL
--   icon            text        NOT NULL DEFAULT 'sun'
--   humidity        integer     NOT NULL DEFAULT 50
--   wind_speed      integer     NOT NULL DEFAULT 5
--   created_at      timestamptz NOT NULL DEFAULT now()
--
-- Constraints carried over from the base migration, unchanged:
--   forecast_date is already UNIQUE. The guarded block at the end only
--   adds the constraint if it is genuinely missing; on the live project
--   it is a no-op. It exists so a fresh `db push` from scratch is safe too.
--
-- `source` is deliberately NOT added. It was dropped as a publish-time field
-- by decision; provenance lives in the weather card and the run record.
--
-- `condition` is deliberately NOT constrained here. The 2026-10-04 seed row
-- carries 'Mostly Cloudy', which is not in the admin panel's own eight-value
-- list, so a CHECK would fail today. That row is deleted by the BEL-5 publish;
-- add the constraint afterwards if you want it.
--
-- Safe to re-run: every statement is idempotent.

begin;

-- ============================================================
-- 1. The deferred columns
-- ============================================================
-- All six are nullable on purpose. The base table's existing columns are all
-- NOT NULL, and making these NOT NULL would fail on the three rows already on
-- the site. The strip renders each one only when it is present.
--
-- `precipitation_chance` is integer, not smallint, to match every other
-- numeric column on this table. Its range is enforced by a CHECK below.
-- `sunrise` / `sunset` are `time`: site-local wall clock for forecast_date.
-- `time` is deliberately not `timetz`, because Postgres normalises a timetz to
-- the session timezone on read, so it does not actually preserve the
-- provider's offset and it would force a formatter into the strip.
alter table public.weather_forecasts
  add column if not exists precipitation_chance integer,
  add column if not exists sunrise             time,
  add column if not exists sunset              time,
  add column if not exists wind_direction      text,
  add column if not exists wind_min            integer,
  add column if not exists wind_max            integer;

comment on column public.weather_forecasts.precipitation_chance is
  'Chance of precipitation, percent 0-100, daytime window. Source of record: NWS gridpoint probabilityOfPrecipitation.';
comment on column public.weather_forecasts.sunrise is
  'Sunrise, site-local wall clock for forecast_date. Source of record: sunrise-sunset.org. Not hand-edited; written by the publish/backfill path.';
comment on column public.weather_forecasts.sunset is
  'Sunset, site-local wall clock for forecast_date. Source of record: sunrise-sunset.org. Not hand-edited; written by the publish/backfill path.';
comment on column public.weather_forecasts.wind_direction is
  'NWS compass code for the daytime wind period. One of N NE E SE S SW W NW Variable Calm. Range lives in wind_min / wind_max.';
comment on column public.weather_forecasts.wind_min is
  'Daytime wind range minimum, mph. wind_speed stays the single reviewed daytime value.';
comment on column public.weather_forecasts.wind_max is
  'Daytime wind range maximum, mph. wind_speed stays the single reviewed daytime value.';

-- ============================================================
-- 2. Bounds on the new numeric columns
-- ============================================================
alter table public.weather_forecasts
  drop constraint if exists weather_forecasts_precipitation_chance_check;
alter table public.weather_forecasts
  add  constraint weather_forecasts_precipitation_chance_check
  check (precipitation_chance is null
         or precipitation_chance between 0 and 100);

alter table public.weather_forecasts
  drop constraint if exists weather_forecasts_wind_min_check;
alter table public.weather_forecasts
  add  constraint weather_forecasts_wind_min_check
  check (wind_min is null or wind_min >= 0);

alter table public.weather_forecasts
  drop constraint if exists weather_forecasts_wind_max_check;
alter table public.weather_forecasts
  add  constraint weather_forecasts_wind_max_check
  check (wind_max is null or wind_max >= 0);

-- A range where the low end is above the high end is a data-entry error.
alter table public.weather_forecasts
  drop constraint if exists weather_forecasts_wind_range_check;
alter table public.weather_forecasts
  add  constraint weather_forecasts_wind_range_check
  check (wind_min is null or wind_max is null or wind_min <= wind_max);

-- ============================================================
-- 3. wind_direction is a closed set, not free text
-- ============================================================
-- The schema decision rejected retyping wind_speed to a text column because a
-- free-text field is unenforceable and the strip cannot format it. The same
-- reasoning is why direction is a short code with a constraint rather than a
-- "NW 5 to 10 mph" string.
alter table public.weather_forecasts
  drop constraint if exists weather_forecasts_wind_direction_check;
alter table public.weather_forecasts
  add  constraint weather_forecasts_wind_direction_check
  check (wind_direction is null or wind_direction in
         ('N','NE','E','SE','S','SW','W','NW','Variable','Calm'));

-- ============================================================
-- 4. The icon contract, enforced by the database
-- ============================================================
-- BEL-14's defect: an NWS icon URL was published into `icon`, the deployed
-- client resolved it through `t1[e] ?? eu` to the sun glyph, and the row read
-- "Sunny" forever. No layer raised an error. `icon` was plain text, so the
-- database accepted the value too.
--
-- These seven codes are the client's closed ICON_MAP in
-- src/components/WeatherForecast.tsx and the admin panel's own option list.
--
-- `icon` is NOT NULL in the base schema, so this CHECK has no NULL branch and
-- is tighter than a nullable one would be.
--
-- Added NOT VALID then VALIDATED separately so the table stays readable to the
-- homepage throughout. All three rows already satisfy it.
alter table public.weather_forecasts
  drop constraint if exists weather_forecasts_icon_check;
alter table public.weather_forecasts
  add  constraint weather_forecasts_icon_check
  check (icon in
         ('sun','cloud','cloud-sun','cloud-rain','cloud-snow','cloud-lightning','cloud-fog'))
  not valid;

alter table public.weather_forecasts
  validate constraint weather_forecasts_icon_check;

-- ============================================================
-- 5. forecast_date stays one row per day
-- ============================================================
-- Already UNIQUE in the base migration. This block is a guard for environments
-- where it is not, so that a re-run of the weather publish cannot create a
-- second row for one date. On the live project it reports a notice and does
-- nothing.
do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'weather_forecasts'
      and i.indisunique
      and i.indnatts = 1
      and (select attname from pg_attribute
            where attrelid = c.oid and attnum = i.indkey[0]) = 'forecast_date'
  ) then
    alter table public.weather_forecasts
      add constraint weather_forecasts_forecast_date_key unique (forecast_date);
    raise notice 'added missing UNIQUE (forecast_date)';
  else
    raise notice 'UNIQUE (forecast_date) already present, no change';
  end if;
end
$$;

commit;

-- ============================================================
-- 6. Grants — one question left: can `authenticated` still UPDATE?
-- ============================================================
-- `anon` is settled and needs no statement here. Measured on the live project:
-- `select=*` as anon returns all nine existing columns, so the anon read grant
-- is table-level and already covers any column added here. An INSERT as anon is
-- refused `42501` by RLS, so anon cannot write and does not need to. **There is
-- deliberately no `grant ... to anon` in this file.** Issuing one would widen
-- nothing useful and is one more thing to get wrong on an unattended run.
--
-- What is NOT settled is `authenticated`, and that is the question that matters.
-- The admin panel writes as `authenticated`, so if its grants are column-scoped
-- rather than table-level it can read the new columns and not write them, and
-- every admin weather save fails. Run this after the transaction above:
--
--   select grantee, privilege_type, count(*)
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'weather_forecasts'
--    group by 1, 2 order by 1, 2;
--
-- NO ROWS for `authenticated`  -> its grants are table-level (the Supabase
--   default) and already cover the six new columns. Stop here. Nothing to do.
--
-- ROWS for `authenticated`      -> column-scoped. Extend in this same change,
--   not as a follow-up. Grant SELECT as well as the writes, or the admin panel
--   half-works in a way that looks fine:
--
--   -- grant select on public.weather_forecasts to authenticated, service_role;
--   -- grant insert, update, delete on public.weather_forecasts
--   --   to authenticated, service_role;
--
-- Why `select` is not optional here. PostgREST expands `select=*` to only the
-- columns the calling role may SELECT, and the admin panel loads the table with
-- `.select('*')`. Give `authenticated` the writes but not the read and every
-- save succeeds while the four fields read back empty: the form renders
-- `f.precipitation_chance ?? ''` as a blank input, so an editor types a value,
-- presses Save, sees no error, and loses it on the next load. The write-only
-- grant turns DoD #5 into a test that passes while showing nothing.
--
-- Left commented on purpose. Which privileges that role actually needs is a
-- person's call made after reading the check, not a migration's, and the
-- migration is written to run unattended. Note that column_privileges reports
-- column-level grants only: a row here is positive proof of column scoping, and
-- the absence of a SELECT row is what makes the read-back above break.
--
-- `weather_public_read` is `TO anon, authenticated USING (true)`, and the
-- homepage strip reads these columns as anon. So whatever the answer to the
-- check, confirm the anonymous read still works afterwards:
--
--   curl -s "$SUPABASE_URL/rest/v1/weather_forecasts?select=forecast_date,precipitation_chance&limit=1"
