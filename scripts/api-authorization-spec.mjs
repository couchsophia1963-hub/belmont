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
 (the `createClient(supabaseUrl, supabaseServiceKey, ...)` at the top of the file).
 Service role bypasses RLS entirely, so on that path the only thing standing between a
 writer key and a mutation is an `if` statement in TypeScript. PostgREST runs as
 `authenticated`, where RLS is the only gate and the TypeScript is not involved at all.

 No line numbers appear anywhere in this spec or the document it generates. That is
 deliberate and it was not the original choice. This file was written against a tree
 where the weather delete guard sat at `index.ts:337-341`; by the time the branch was
 rebased onto `main` eleven pull requests later the same guard was at 363-365, and the
 other two citations had moved from 10,12 to 11,13 and from 61 to 35. All three were
 wrong and nothing said so, because nothing checks them and a stale line number still
 reads like it was verified. A commit SHA does not move, so the durable citations here
 are SHAs and the text of the guard, not coordinates.

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
                     in code, and the code is meant to carry no gate for it.
                     Reported, never failed. Engineering does not get to settle these
                     alone.
   mitigated_unapplied
                     The repository contains a control that closes the gap, and the
                     migration that carries it has not been applied to the live
                     database. Reported, never failed, because merging is not applying
                     and this table records the repository, not the database. A
                     `columnGuards` entry on such a row is still asserted: if the
                     trigger disappears from the migrations, that fails.

 Rows in any status other than `settled` print on every run, on both surfaces, and the
 printing is itself asserted. A gap that only prints for one surface, or that stops
 printing because the reporting path changed, is a gap that looks closed.

 STATUS VALUES THAT ARE NOT ROW STATUSES

   `unknown`   what this file reports when it will not guess: a role test it does not
               recognise, a command covered by more than one permissive policy, a
               restrictive policy, or a policy expression that is not a rule it knows.
               `unknown` is never a passing result. A `settled` row that reads
               `unknown` fails.

 ROW SHAPES

   surface       `api` for a row about the edge function, `postgrest` for a row about
                 a table. An `api` row names the RLS row that governs the same
                 mutation for a signed-in session, so the two can be compared.
   functionRule  what the branch enforces: `admin` for a `profile.role !== "admin"`
                 test, `writer` for no role test at all (see `canonical` in the
                 checker -- both mean the branch admits any writer).
   rlsRule       what the live policy admits.
   columnGuards  column -> trigger name, for a trigger that refuses a change to one
                 column. Asserted on every run regardless of status.
   editorialRef  a pointer to the newsroom rule, not a paraphrase of it. The newsroom
                 half of this contract lives in BEL-61's `api-of-record` and is not
                 restated here; this file holds the code facts that document defers to.

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

/*
 Writes in `index.ts` that sit outside every `if (resource === ...)` and
 `if (action === ...)` body, so no branch in the table describes them. Declaring one
 here is the statement that it is not an authorisation surface, with a reason.

 The coverage boundary of the branch table is exactly this: mutations inside an action
 branch, and mutations inside a declared row here. Anything else in the file is a
 failure, because a write that no row claims is a write nobody has answered "who may
 do this" about.
*/
export const OUT_OF_BRANCH_WRITES = [
  {
    id: "api_keys.last_used_at",
    table: "api_keys",
    marker: "last_used_at",
    note: "Authenticate() refreshes the caller's key timestamp before it checks the profile. It is a write on the caller's own key, keyed on the presented secret, and it grants nothing: the row is selected by key_hash before this runs, so an unknown key updates nothing. It is here to be declared, not because it is an authorisation surface.",
  },
];

/*
 Surfaces that can reach the database or change who may write, which the branch,
 policy and trigger models do not describe, and which therefore have to be declared
 here with the reason they are not an authorisation surface.

 The check is a deny-list over these. Anything the scan finds that is neither
 described by a row in SPEC nor declared here is `UNMODELLED SURFACE` -- a failure
 saying the checker cannot answer who may do it, rather than a guess that it is fine.
 An earlier version enumerated the four table-write primitives and reported PASS on
 everything else, which fails open: `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` and
 `.rpc("escalate_my_role")` both bypass every policy and both printed PASS.

 Each entry is `kind` and `name`, matching what the scan reports, plus the reason.
 A widening that is genuinely intended belongs in the models instead of here: this
 list is for surfaces that carry no authority, and an entry that reads like a
 justification for a widening is in the wrong place.

   kind               name
   ----               ----
   rls-off            "<table>: RLS disabled, no policy is consulted"
   grant              "GRANT ... TO ..." / "REVOKE ... FROM ..."
   security-definer   the function name
   call               the method name, e.g. `rpc`
   fetch              "mutating method"
   service-role       "referenced outside the client construction"
*/
export const DECLARED_SURFACES = [
  {
    kind: "security-definer",
    name: "handle_new_user",
    note: "The signup trigger on auth.users. It INSERTs one profiles row for the account being created and hard-codes role='user', ignoring raw_user_meta_data, so it cannot be used to choose a role. It is not exposed through PostgREST: no GRANT EXECUTE names it, and Supabase exposes only functions in the exposed schema with a grant. Read anyway, because it is a SECURITY DEFINER function that writes.",
  },
  {
    kind: "security-definer",
    name: "guard_profiles_role_update",
    note: "The trigger function for profiles_guard_role_update. It raises rather than writes, and `search_path` is pinned. Declared because it is SECURITY DEFINER and therefore runs as its owner; the column it guards is asserted by the rls.profiles.update row.",
  },
  {
    kind: "security-definer",
    name: "stories_guard_lock_columns",
    note: "The trigger function for stories_guard_lock_columns. It raises rather than writes, and `search_path` is pinned. The columns it guards are asserted by the stories.lock and stories.unlock rows.",
  },
  {
    kind: "grant",
    name: "REVOKE ALL ON public.comments_public FROM PUBLIC",
    note: "Narrows. It takes the default privileges on a view away from PUBLIC so the GRANT on the next line is the whole grant. Read-only surface either way.",
  },
  {
    kind: "grant",
    name: "GRANT SELECT ON public.comments_public TO anon, authenticated",
    note: "The public comment view, and the only grant in the repository. SELECT on a view, so it cannot change a row, and the view exposes id, author name, body, created_at. This is the intended public surface for comments and is why comments need no writer role to be read.",
  },
  {
    kind: "grant",
    name: "ALTER comments_public OWNER TO postgres",
    note: "Ownership, not a grant to a client role. postgres is the migration role and never authenticates as a PostgREST subject, so this widens nothing a reader can reach.",
  },

  /*
    The next nine arrived on main tonight, from the headline-invariant and
    byline-change migrations. They are here because the scan found them, not because
    anybody went looking, which is the only reason to trust the list being complete.

    Five of the nine narrow. Four are grants onto functions that are SECURITY INVOKER,
    which is the distinction that decides all four: an invoker function runs with the
    caller's authority, so RLS still governs every statement inside it and the function
    cannot reach a row its caller could not reach with the same UPDATE. A definer
    function is the opposite, and the one definer function below is declared for exactly
    that reason.
  */
  {
    kind: "grant",
    name: "REVOKE all on function public.set_story_headline(uuid, boolean) from public",
    note: "Narrows. Takes the function away from PUBLIC before the GRANT below, so the GRANT is the whole grant and not an addition to Postgres' default EXECUTE to PUBLIC. Same reason as the comments_public REVOKE two entries up.",
  },
  {
    kind: "grant",
    name: "REVOKE all on function public.set_story_headline(uuid, boolean) from anon",
    note: "Narrows. An anonymous reader never gets to move the homepage headline, which is what the revoke guarantees even if a later migration grants EXECUTE to anon by accident.",
  },
  {
    kind: "grant",
    name: "GRANT execute on function public.set_story_headline(uuid, boolean) to authenticated",
    note: "Reachable by any signed-in user through PostgREST, so it is worth naming rather than waving through. SECURITY INVOKER with search_path pinned to public, so the UPDATE inside it runs as the caller and `stories_writer_update` is still the only thing deciding which rows move. What it does carry is editorial authority: it sets `is_headline`, which is the same class of decision as publish and unpublish. That is consistent with the answer BEL-258 recorded for those, so it is declared here rather than quietly read as a new gap. If BEL-258 is ever revisited, this is the row to revisit with it.",
  },
  {
    kind: "grant",
    name: "REVOKE ALL ON TABLE public.story_byline_changes FROM PUBLIC",
    note: "Narrows. The audit table starts from nothing rather than from Postgres' default, so the GRANT on the next line is the whole grant.",
  },
  {
    kind: "grant",
    name: "REVOKE ALL ON TABLE public.story_byline_changes FROM anon, authenticated, service_role",
    note: "Narrows, and the deliberate half of the design. It takes every write privilege away from every role so that the only INSERT policy that can exist is none, which is how the table keeps an append-only property even if somebody adds a GRANT by hand later. service_role included: the trigger below inserts as its owner, not through this grant.",
  },
  {
    kind: "grant",
    name: "GRANT SELECT ON TABLE public.story_byline_changes TO authenticated, service_role",
    note: "A read. SELECT cannot change a row, and the table grants INSERT, UPDATE and DELETE to nobody at all, so the audit log is readable by the desk and writable by no one reachable from a request.",
  },
  {
    kind: "grant",
    name: "REVOKE ALL ON FUNCTION public.change_story_byline(uuid, uuid, uuid, text, text) FROM PUBLIC",
    note: "Narrows. Same pattern as set_story_headline: revoke from PUBLIC first so the GRANT below is the whole grant.",
  },
  {
    kind: "grant",
    name: "GRANT EXECUTE ON FUNCTION public.change_story_byline(uuid, uuid, uuid, text, text) TO authenticated, service_role",
    note: "The one grant here that is worth reading the body for, because the function takes a caller-supplied `p_actor_profile_id` and the caller-supplied actor is the same shape as the self-promotion BEL-224 closed. Read, it holds: a signed-in session may attribute only to itself and an asserted actor must be writer or admin, both enforced with RAISE EXCEPTION before the UPDATE. SECURITY INVOKER with search_path pinned, so `stories_writer_update` decides which stories move. Declared on the strength of that read, and the check is what made the read happen.",
  },
  {
    kind: "security-definer",
    name: "stories_log_byline_change",
    note: "The one entry here that does carry authority, which is why it is declared rather than waved through. SECURITY DEFINER, so it inserts into story_byline_changes as its owner, and that table grants INSERT to nobody. It has to be a definer function to write at all; that is the design and it is not a bypass of a policy, because there is no policy it is bypassing. `search_path` is pinned to public so it is not search-path injectable. It is a trigger, so it fires inside someone else's UPDATE rather than being callable on its own, and it writes one audit row and nothing else. Declared as a capability the table does not model as a control: it does not authorise a caller's write, it records one.",
  },
];

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
    status: "settled",
    editorialRef: "api-of-record rule 4: publish requires an APPROVED QA verdict on the item's task.",
    decidedBy: "BEL-258",
    note: "Any writer key, on both surfaces. No role gate, and that is the ruling rather than an omission: rule 4 lives on the task, not in the database, so the backend cannot carry it, and a role test would only move the bypass to whoever holds the key. Settled, so a role gate added later fails this check until somebody updates the table deliberately.",
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
    status: "settled",
    editorialRef: "api-of-record rule 3: unpublish needs the editor's instruction, not an engineer's judgement.",
    decidedBy: "BEL-258",
    note: "Any writer key, on both surfaces, and that is the contract. It is not quite unrestricted: it refuses a locked story with 409. Rule 3 is enforced by the newsroom and by nothing else, which the ruling records as intended. An admin gate would move the bypass to whoever holds the admin key rather than close it, and would make every takedown wait on one person while a wrong story stays live.",
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
    status: "mitigated_unapplied",
    editorialRef: "api-of-record rule 3 names lock as well as unpublish: lock needs the editor's instruction. Rule 7: do not lock a story the editor may need to take down.",
    columnGuards: { locked: "stories_guard_lock_columns" },
    note: "The function tests admin. PostgREST does not: stories_writer_update admits any writer for every column, so on its own a writer can PATCH locked=true through PostgREST. Migration 20261005200000 closes that in the repository with the trigger named above, which refuses a change to locked or locked_until from any caller that is not an admin. Not applied to the live database. Tracked on BEL-122, which the board confirmed as the canonical ticket for this hole; BEL-253 was closed as its duplicate. What a lock means is unchanged by the gap: it prevents deletion and unpublishing, and it is not a freeze -- a locked story stays correctable with update, deliberately.",
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
    status: "mitigated_unapplied",
    columnGuards: { locked: "stories_guard_lock_columns", locked_until: "stories_guard_lock_columns" },
    note: "The function tests admin. Through PostgREST on its own, a writer could clear a lock an admin set, which also reopens the row to stories_admin_delete and to unpublish. Same gap as stories.lock and the more damaging half. The same 20261005200000 trigger refuses it: locked_until is in its column pair, so both halves are covered by one trigger. Not applied to the live database. Tracked on BEL-122.",
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
    editorialRef: "api-of-record rule 5: delete on either resource is off limits without an explicit board decision.",
    note: "Admin only, on both surfaces. The function guard is the `profile.role !== \"admin\"` test in the delete branch, landed in `d35e72a` (PR #9); RLS renamed weather_writer_delete to weather_admin_delete in 20261005170000 (PR #20, 63f543c). There is no lock or published equivalent to slow a writer down, which made it the least braked action in the function and the one this table was written for. BEL-235 reported it as ungated; it was gated on main already. Cited by commit rather than by line, because the line moved twice under a rebase and nothing here checks it.",
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
    status: "mitigated_unapplied",
    columnGuards: { role: "profiles_guard_role_update" },
    note: "USING (auth.uid() = id) WITH CHECK (auth.uid() = id). RLS is row-level, so on its own this row does not constrain the role column, and an authenticated user who could write it could make themselves an admin -- the key to every role check in the function, because authenticate() reads this column. 20261005190000 adds the BEFORE UPDATE OF role trigger named above, which refuses a role change from any caller that is not service_role, a no-JWT session, or an existing admin. That closes it in the repository; the migration has not been applied to the live database, and that is the whole difference between this row and a settled one. Review by 2026-01-05: if it is still unapplied then, this row stays and the check keeps saying so.",
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