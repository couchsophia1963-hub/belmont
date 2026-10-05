/*
 Belmont News -- who is allowed to do what.

 This file is the specification. `check-api-authorization.mjs` holds the checker.
 Nothing here is behaviour: no grant, no policy, no guard is created by adding a
 row. A row is a claim about what the two write paths already enforce, and the
 checker's only job is to notice when the code stops matching the claim.

 WHY A SPECIFICATION AND NOT ANOTHER FIX

 The defects this file exists to stop repeating are all the same defect. Each was
 found by one person reading one action of `supabase/functions/api/index.ts`,
 noticing the missing gate, and reporting it. That method finds one action per
 pass and it finds whatever the reader happened to be looking at. Five mutating
 actions produced three different authorization answers, and the answer nobody
 noticed is the one that decided the outcome.

 A written table plus a check that fails on drift replaces that method with a
 repeatable one: the table says what should be true, the check says whether it
 is, and a new action with no row is a failure rather than a surprise.

 THE TWO SURFACES, AND WHY THEY HAVE TO BE READ TOGETHER

 `supabase/functions/api/index.ts` builds its client with SUPABASE_SERVICE_ROLE_KEY
 (`index.ts:10,12`). Service role bypasses RLS entirely, so on that path the only
 thing standing between a writer key and a mutation is an `if` statement in
 TypeScript. PostgREST runs as `authenticated`, where RLS is the only gate and the
 TypeScript is not involved at all.

 Neither surface is a backstop for the other. A guard in the function is invisible
 to `DashboardPage`; a policy is invisible to the function. Any statement about who
 may do something has to name both, and any drift between them is a finding.

 STATUS VALUES, AND WHAT THE CHECKER DOES WITH EACH

   settled           Both surfaces enforce the rule in this row. If the code stops
                     matching, the check fails.
   known_gap         The two surfaces genuinely disagree and the disagreement is
                     recorded, understood and carried as an open ticket. Reported
                     loudly on every run, never a build failure, because a check
                     that is permanently red is a check people learn to ignore. If
                     the observed state changes at all the check says so and asks
                     for the spec to be updated -- that is how a gap gets closed.
   editorially_gated The newsroom answered this one in an editorial document, not
                     in code. Reported, never failed, never used to justify a code
                     change. Engineering does not get to settle these alone.

 Rows are marked `mutating: false` where the surface only reads. They are listed
 for completeness and are not asserted.

 Generated documentation is header prose + this table + footer prose, spliced
 together by the checker into `docs/api-authorization.md`. The prose lives in
 `docs/api-authorization.header.md` and `docs/api-authorization.footer.md` so it
 stays markdown; this file stays data.
*/

export const FUNCTION_PATH = "supabase/functions/api/index.ts";
export const MIGRATIONS_DIR = "supabase/migrations";
export const DOC_PATH = "docs/api-authorization.md";
export const DOC_HEADER_PATH = "docs/api-authorization.header.md";
export const DOC_FOOTER_PATH = "docs/api-authorization.footer.md";

export const SPEC = [
  {
    id: "stories.create",
    surface: "api",
    resource: "stories",
    action: "create",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: false,
    table: "stories",
    command: "INSERT",
    status: "settled",
    note: "Any writer key. Matches stories_writer_insert, so the two surfaces agree.",
  },
  {
    id: "stories.update",
    surface: "api",
    resource: "stories",
    action: "update",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: false,
    table: "stories",
    command: "UPDATE",
    status: "settled",
    editorialRef: "api-of-record rule 2: a correction is update, never delete.",
    note: "No lock check, deliberately (BEL-83 item 2): a locked story must stay correctable.",
  },
  {
    id: "stories.delete",
    surface: "api",
    resource: "stories",
    action: "delete",
    mutating: true,
    functionRule: "admin",
    functionLockCheck: true,
    table: "stories",
    command: "DELETE",
    status: "settled",
    editorialRef: "api-of-record rule 5: delete is off limits without a board decision.",
    note: "Admin only, and refuses a locked story with 409. stories_admin_delete agrees on both.",
  },
  {
    id: "stories.publish",
    surface: "api",
    resource: "stories",
    action: "publish",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: false,
    table: "stories",
    command: "UPDATE",
    status: "editorially_gated",
    editorialRef: "api-of-record rule 4: publish needs an APPROVED QA verdict on the task.",
    note: "No role restriction on either surface. The QA gate is a human process and the code does not carry it.",
  },
  {
    id: "stories.unpublish",
    surface: "api",
    resource: "stories",
    action: "unpublish",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: true,
    table: "stories",
    command: "UPDATE",
    status: "editorially_gated",
    editorialRef: "api-of-record rule 3: unpublish needs the editor's instruction, not an engineer's judgement.",
    note: "Writer-accessible on both surfaces. Refuses a locked story (409). Whether the role gate should exist is BEL-156's question and is not settled here.",
  },
  {
    id: "stories.lock",
    surface: "api",
    resource: "stories",
    action: "lock",
    mutating: true,
    functionRule: "admin",
    functionLockCheck: false,
    table: "stories",
    command: "UPDATE",
    status: "known_gap",
    note: "The function tests admin. PostgREST does not: stories_writer_update admits any writer for every column, so a writer can PATCH locked=true on the function's own terms. Tracked on BEL-253.",
  },
  {
    id: "stories.unlock",
    surface: "api",
    resource: "stories",
    action: "unlock",
    mutating: true,
    functionRule: "admin",
    functionLockCheck: false,
    table: "stories",
    command: "UPDATE",
    status: "known_gap",
    note: "The function tests admin. Through PostgREST a writer can clear a lock an admin set, which also reopens the row to stories_admin_delete and to unpublish. Same gap as stories.lock, and the more damaging half. Tracked on BEL-253.",
  },
  {
    id: "weather.upsert",
    surface: "api",
    resource: "weather",
    action: "upsert",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: false,
    table: "weather_forecasts",
    command: "INSERT",
    status: "settled",
    note: "One card per forecast_date. Matches weather_writer_insert.",
  },
  {
    id: "weather.create",
    surface: "api",
    resource: "weather",
    action: "create",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: false,
    table: "weather_forecasts",
    command: "INSERT",
    status: "settled",
    note: "Shares the upsert branch, `action === \"upsert\" || action === \"create\"`.",
  },
  {
    id: "weather.update",
    surface: "api",
    resource: "weather",
    action: "update",
    mutating: true,
    functionRule: "writer",
    functionLockCheck: false,
    table: "weather_forecasts",
    command: "UPDATE",
    status: "settled",
    note: "Matches weather_writer_update.",
  },
  {
    id: "weather.delete",
    surface: "api",
    resource: "weather",
    action: "delete",
    mutating: true,
    functionRule: "admin",
    functionLockCheck: false,
    table: "weather_forecasts",
    command: "DELETE",
    status: "settled",
    note: "The subject of BEL-235. Function guard at index.ts:337-341 (PR #9, d35e72a), RLS renamed weather_writer_delete to weather_admin_delete in 20261005170000 (PR #20, 63f543c). Both surfaces admin-only. There is no lock or published equivalent, so this was the least braked action in the function.",
  },
  {
    id: "rls.stories.insert",
    surface: "postgrest",
    table: "stories",
    command: "INSERT",
    mutating: true,
    policy: "stories_writer_insert",
    rlsRule: "writer",
    rlsLockCheck: false,
    status: "settled",
    note: "WITH CHECK admits writer and admin.",
  },
  {
    id: "rls.stories.update",
    surface: "postgrest",
    table: "stories",
    command: "UPDATE",
    mutating: true,
    policy: "stories_writer_update",
    rlsRule: "writer",
    rlsLockCheck: false,
    status: "settled",
    note: "Row-level and column-blind. This is the policy that makes the stories.lock and stories.unlock rows above real.",
  },
  {
    id: "rls.stories.delete",
    surface: "postgrest",
    table: "stories",
    command: "DELETE",
    mutating: true,
    policy: "stories_admin_delete",
    rlsRule: "admin",
    rlsLockCheck: true,
    status: "settled",
    note: "Admin and locked = false. Replaced by 20261005123424 to carry the lock clause.",
  },
  {
    id: "rls.weather_forecasts.insert",
    surface: "postgrest",
    table: "weather_forecasts",
    command: "INSERT",
    mutating: true,
    policy: "weather_writer_insert",
    rlsRule: "writer",
    rlsLockCheck: false,
    status: "settled",
    note: "WITH CHECK admits writer and admin.",
  },
  {
    id: "rls.weather_forecasts.update",
    surface: "postgrest",
    table: "weather_forecasts",
    command: "UPDATE",
    mutating: true,
    policy: "weather_writer_update",
    rlsRule: "writer",
    rlsLockCheck: false,
    status: "settled",
    note: "USING and WITH CHECK both admit writer and admin.",
  },
  {
    id: "rls.weather_forecasts.delete",
    surface: "postgrest",
    table: "weather_forecasts",
    command: "DELETE",
    mutating: true,
    policy: "weather_admin_delete",
    rlsRule: "admin",
    rlsLockCheck: false,
    status: "settled",
    note: "Renamed from weather_writer_delete by 20261005170000. The old name would have been a lie after the change.",
  },
  {
    id: "rls.profiles.update",
    surface: "postgrest",
    table: "profiles",
    command: "UPDATE",
    mutating: true,
    policy: "profiles_owner_update",
    rlsRule: "owner",
    rlsLockCheck: false,
    status: "known_gap",
    note: "USING (auth.uid() = id) WITH CHECK (auth.uid() = id). Row-level, so the role column is not constrained: any authenticated user can set their own role to admin. Any authenticated user can therefore make themselves an admin, which is the key to every role check in the edge function, because authenticate() reads this column. Tracked on BEL-251, which outranks this row.",
  },
  {
    id: "rls.comments.insert",
    surface: "postgrest",
    table: "comments",
    command: "INSERT",
    mutating: true,
    policy: "comments_user_insert",
    rlsRule: "owner",
    rlsLockCheck: false,
    status: "settled",
    note: "WITH CHECK (auth.uid() = user_id). Cannot post as somebody else.",
  },
  {
    id: "rls.comments.update",
    surface: "postgrest",
    table: "comments",
    command: "UPDATE",
    mutating: true,
    policy: "comments_owner_update",
    rlsRule: "owner",
    rlsLockCheck: false,
    status: "settled",
    note: "Own comments only, both directions.",
  },
  {
    id: "rls.comments.delete",
    surface: "postgrest",
    table: "comments",
    command: "DELETE",
    mutating: true,
    policy: "comments_owner_or_admin_delete",
    rlsRule: "owner_or_admin",
    rlsLockCheck: false,
    status: "settled",
    note: "Owner or admin.",
  },
  {
    id: "rls.api_keys.insert",
    surface: "postgrest",
    table: "api_keys",
    command: "INSERT",
    mutating: true,
    policy: "api_keys_owner_insert",
    rlsRule: "owner",
    rlsLockCheck: false,
    status: "settled",
    note: "A user may mint a key for themselves, not for anyone else.",
  },
  {
    id: "rls.api_keys.delete",
    surface: "postgrest",
    table: "api_keys",
    command: "DELETE",
    mutating: true,
    policy: "api_keys_owner_delete",
    rlsRule: "owner",
    rlsLockCheck: false,
    status: "settled",
    note: "Revocation is the user's own to do.",
  },
];