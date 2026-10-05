#!/usr/bin/env node
/*
 Check the code against `api-authorization-spec.mjs`.

 No dependencies, no network, no database. It reads three things as text:
 `supabase/functions/api/index.ts`, `supabase/migrations/*.sql`, and the generated
 document, works out what each mutating action is actually allowed to do today, and
 compares that against what the spec claims.

 Exit 0 clean, exit 1 on a failure. `--print` writes the generated document to
 stdout, `--write-doc` rewrites docs/api-authorization.md, `--debug` dumps the parsed
 model.

 Added on BEL-235, where the same defect was found three times by three people
 reading the function action by action. The point of this file is to make the
 fourth occurrence a build failure rather than a discovery.

 WHAT THIS FILE REFUSES TO DO

 It never reports PASS for a rule it did not read itself. An unrecognised role test,
 a column with more than one live policy, a restrictive policy, a trigger that is not
 there any more -- all of those are failures, not `unknown` that slides through as a
 green build. `unknown` is a result, and it is never a passing one.
*/

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEC,
  OUT_OF_BRANCH_WRITES,
  DOC_PATH,
  DOC_HEADER_PATH,
  DOC_FOOTER_PATH,
  FUNCTION_PATH,
  MIGRATIONS_DIR,
} from "./api-authorization-spec.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MUTATING_COMMANDS = ["INSERT", "UPDATE", "DELETE"];
const MUTATION_CALL = /\.(?:insert|update|delete|upsert)\s*\(/g;

const STATUS_LABEL = {
  settled: "settled",
  known_gap: "KNOWN GAP",
  mitigated_unapplied: "MITIGATED, UNAPPLIED",
  editorially_gated: "EDITORIAL",
};
const REPORTED_STATUSES = ["known_gap", "mitigated_unapplied", "editorially_gated"];

/*
 What each RLS rule admits, as a set of subjects. Postgres OR-s every permissive
 policy for a given command, so the effective rule for a (table, command) pair is the
 union of its policies' sets -- not the last one written. Modelling that as "last
 policy wins" is what let a broad `USING (true)` policy hide behind a narrow one.

   public          anyone, including anon
   writer          profiles.role IN ('writer', 'admin')
   admin           profiles.role = 'admin'
   owner           the row's owner column equals auth.uid(), whoever they are
*/
const RULE_SUBJECTS = {
  public: ["public"],
  writer: ["writer"],
  admin: ["admin"],
  owner: ["owner"],
  owner_or_admin: ["owner", "admin"],
};

const findings = { fail: [], info: [] };
const reported = [];

// ============================================================== text utilities

function skipString(src, quoteAt, quote) {
  let i = quoteAt + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/*
 Blank out SQL comments, preserving every newline and every offset, so the line
 numbers a finding quotes still point at the right line.

 This is not a nicety for this repository. These migrations document themselves by
 quoting the DDL they replace: 20261005190000_profiles_role_not_self_assignable.sql
 opens with the text of `profiles_owner_update` inside a block comment, so a parser
 that does not skip comments reads it as a second live policy on profiles and then
 reports the row as unresolvable. Worse, it would report it as unresolvable for the
 wrong reason, which is the same failure as reporting PASS for the wrong reason.
*/
function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(sql, i, c);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function blockAfter(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && next === "*") {
      i = src.indexOf("*/", i);
      if (i === -1) break;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, c);
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return { open, close: i, bodyStart: open + 1, body: src.slice(open + 1, i) };
    }
    i += 1;
  }
  return null;
}

function parenBody(src, openParen) {
  let depth = 0;
  let i = openParen;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, c);
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
    i += 1;
  }
  return "";
}

function all(re, src) {
  const out = [];
  re.lastIndex = 0;
  let m = re.exec(src);
  while (m) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1;
    m = re.exec(src);
  }
  return out;
}

function lineAt(src, index) {
  return src.slice(0, index).split("\n").length;
}

function migrationFiles() {
  return readdirSync(join(ROOT, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readMigration(file) {
  return stripSqlComments(readFileSync(join(ROOT, MIGRATIONS_DIR, file), "utf8"));
}

// ============================================================== the function

/*
 `none` and `writer` mean the same thing to an authoriser: the branch has no role
 test of its own, so the call is gated only by authenticate(), which admits any
 `bcn_` key whose profile is a writer or an admin. The two are kept apart for
 display so the generated table can say which of the two a row actually is.
*/
function canonical(rule) {
  return rule === "none" ? "writer" : rule;
}

function roleTestOf(src) {
  if (/profile\.role\s*!==\s*"admin"/.test(src)) return "admin";
  if (/profile\.role\s*===\s*"admin"/.test(src)) return "non_admin";
  if (/profile\.role\s*!==\s*"writer"\s*&&\s*profile\.role\s*!==\s*"admin"/.test(src)) return "writer";
  // A role test this file does not recognise is worse than no role test at all: no
  // role test means the answer is "any writer", which is at least a known answer.
  // `profile.role !== "subeditor"` is a narrower rule that the table would misreport
  // as the wider one, so it has to fail rather than degrade.
  if (/profile\.role/.test(src)) return "unknown";
  return "none";
}

function mutates(src) {
  return /\.(?:insert|update|delete|upsert)\s*\(/.test(src);
}

function lockChecked(src) {
  return /select\(\s*"locked"/.test(src) && /\.locked\b/.test(src);
}

function inRanges(index, ranges) {
  return ranges.some(([a, b]) => index >= a && index <= b);
}

/*
 Walk the function's resource blocks, then the action branches inside each, and
 record what each branch actually enforces. `action === "upsert" || action ===
 "create"` is one branch serving two actions, so a shared branch yields two entries
 with the same enforcement.

 The absolute offsets of the branch bodies are returned too, because the scan for
 writes that sit outside every branch is the only way to know the table covers the
 whole file rather than the part it happens to recognise.
*/
function parseFunction(src) {
  const branches = [];
  const branchRanges = [];

  for (const r of all(/if\s*\(\s*resource\s*===\s*"([a-z]+)"\s*\)/g, src)) {
    const block = blockAfter(src, r.index + r[0].length);
    if (!block) continue;
    for (const a of all(/if\s*\(\s*action\s*===\s*"([a-z]+)"([^)]*)\)\s*\{/g, block.body)) {
      const openInBlock = block.body.indexOf("{", a.index + a[0].length - 1);
      const branch = blockAfter(block.body, openInBlock);
      if (!branch) continue;
      branchRanges.push([block.bodyStart + branch.open, block.bodyStart + branch.close]);
      const absolute = block.bodyStart + a.index;
      const shared = [...a[2].matchAll(/action\s*===\s*"([a-z]+)"/g)].map((m) => m[1]);
      const base = {
        resource: r[1],
        functionRule: roleTestOf(branch.body),
        functionLockCheck: lockChecked(branch.body),
        mutates: mutates(branch.body),
        line: lineAt(src, absolute),
      };
      branches.push({ ...base, action: a[1] });
      for (const s of shared) branches.push({ ...base, action: s });
    }
  }
  return { branches, branchRanges };
}

/*
 Every mutating Supabase call in the file, attributed to the statement it belongs to.
 A call whose offset falls outside every action branch is a write the branch table
 does not describe -- see OUT_OF_BRANCH_WRITES in the spec.

 Attribution is per statement, not per window. A window around the call would claim
 whichever text happened to be nearby, and two writes on adjacent lines are exactly the
 case that matters: a self-escalation planted right above the one declared write would
 borrow its declaration and pass.
*/
function findStrayWrites(src, branchRanges) {
  const strays = [];
  let prevEnd = -1;
  for (const m of all(MUTATION_CALL, src)) {
    if (inRanges(m.index, branchRanges)) {
      prevEnd = m.index;
      continue;
    }
    const froms = [...src.slice(prevEnd + 1, m.index).matchAll(/\.from\(\s*"([A-Za-z0-9_]+)"\s*\)/g)];
    const from = froms.length ? froms[froms.length - 1] : null;
    const stmtEnd = src.indexOf(";", m.index);
    const end = stmtEnd === -1 ? Math.min(src.length, m.index + 300) : stmtEnd;
    strays.push({
      index: m.index,
      line: lineAt(src, m.index),
      call: m[0],
      table: from ? from[1] : null,
      stmt: from ? src.slice(prevEnd + 1 + from.index, end) : "",
      stmtLine: from ? lineAt(src, prevEnd + 1 + from.index) : lineAt(src, m.index),
    });
    prevEnd = m.index;
  }
  return strays;
}

// ============================================================== RLS

function classifyRule(expr) {
  const owner = /auth\.uid\(\)\s*=\s*[A-Za-z_][A-Za-z0-9_]*/.test(expr);
  const admin = /role\s*=\s*'admin'/.test(expr);
  const writer = /role\s+IN\s*\(/.test(expr);
  if (owner && admin) return "owner_or_admin";
  if (owner) return "owner";
  if (admin) return "admin";
  if (writer) return "writer";
  if (/^\s*true\s*$/.test(expr.trim())) return "public";
  return "unknown";
}

/*
 CREATE POLICY and DROP POLICY in file order, with the later migration replacing the
 earlier one the same way the database applies them. Statements are merged by position
 so a DROP followed by a CREATE of the same name inside one file leaves the policy
 live, which is the normal shape of these migrations.

 Live policies are accumulated per (table, command) rather than replaced, because
 Postgres OR-s every permissive policy for a command. One policy is read directly.
 Several, or any restrictive policy, resolve to `unknown`: the union is still computed
 and printed so the operator can see how wide the pair got, but a row is never called
 settled on a rule this file did not read itself.
*/
function parsePolicies() {
  const live = new Map();
  const add = (key, policy) => {
    if (!live.has(key)) live.set(key, []);
    live.get(key).push(policy);
  };

  for (const file of migrationFiles()) {
    const sql = readMigration(file);
    const statements = [];

    for (const d of all(
      /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?/gi,
      sql,
    )) {
      statements.push({ index: d.index, kind: "drop", name: d[1], table: d[2] });
    }

    // `AS RESTRICTIVE` sits between the table name and FOR. It has to be matched, not
    // skipped: a restrictive policy composes with AND, which is the opposite of the OR
    // that every other policy on the command goes through.
    for (const c of all(
      /CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s+(?:(AS\s+RESTRICTIVE)\s+)?FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([A-Za-z0-9_,'" ]+?)\s+((?:WITH\s+CHECK|USING)\s*\()/gi,
      sql,
    )) {
      statements.push({
        index: c.index,
        kind: "create",
        name: c[1],
        table: c[2],
        cmd: c[4].toUpperCase(),
        roles: c[5].trim(),
        parenAt: c.index + c[0].length - 1,
        restrictive: Boolean(c[3]),
        file,
      });
    }

    statements.sort((a, b) => a.index - b.index);

    for (const st of statements) {
      if (st.kind === "drop") {
        for (const [key, list] of [...live]) {
          const kept = list.filter((p) => !(p.name === st.name && p.table === st.table));
          if (kept.length === 0) live.delete(key);
          else live.set(key, kept);
        }
        continue;
      }
      const expr = parenBody(sql, st.parenAt);
      const second = /\)\s*(WITH\s+CHECK|USING)\s*\(/.exec(sql.slice(st.parenAt));
      let expr2 = "";
      if (second) expr2 = parenBody(sql, st.parenAt + second.index + second[0].length - 1);
      const commands = st.cmd === "ALL" ? MUTATING_COMMANDS.concat("SELECT") : [st.cmd];
      for (const cmd of commands) {
        add(`${st.table}:${cmd}`, {
          name: st.name,
          table: st.table,
          cmd,
          roles: st.roles,
          expr: `${expr} ${expr2}`,
          restrictive: st.restrictive,
          file,
          line: lineAt(sql, st.index),
        });
      }
    }
  }

  const out = new Map();
  for (const [key, list] of live) {
    const subjects = new Set();
    for (const p of list) {
      for (const sub of RULE_SUBJECTS[classifyRule(p.expr)] || ["unknown"]) subjects.add(sub);
    }
    out.set(key, {
      key,
      policies: list,
      rule:
        list.some((p) => p.restrictive) || list.length !== 1
          ? "unknown"
          : classifyRule(list[0].expr),
      union: [...subjects].sort(),
      multiPolicy: list.length > 1,
      restrictive: list.some((p) => p.restrictive),
      lockCheck: list.some((p) => /locked\s*=\s*false/.test(p.expr)),
      names: list.map((p) => p.name),
    });
  }
  return out;
}

/*
 The third enforcement surface. A trigger is neither a policy nor a line of
 TypeScript: it fires for every caller of the table, including the ones RLS has
 already admitted, and RLS cannot see it.

 Only a trigger that refuses is a control, so a trigger counts as one only when the
 function it calls raises an exception. One that audits or rewrites is recorded and
 not counted, because "there is a trigger on this table" is not the same answer as
 "this table refuses this write".
*/
function parseTriggers() {
  const triggers = [];
  for (const file of migrationFiles()) {
    const sql = readMigration(file);
    /*
     The gap between `FOR EACH ROW` and `EXECUTE FUNCTION` is matched with `[\s\S]*?`
     rather than `.*?`, because `.` does not cross a newline and this repository writes
     it both ways:

       FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_role_update();   -- one line
       FOR EACH ROW
         EXECUTE FUNCTION public.stories_guard_lock_columns();             -- two

     A dot that does not cross a newline does not fail loudly. It silently finds no
     trigger, so a guard the repository carries reads as absent and the rows that depend
     on it go quiet. That is the false-PASS shape again, one level down.
    */
    for (const m of all(
      /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?([A-Za-z0-9_]+)"?\s+((?:BEFORE|AFTER|INSTEAD\s+OF)\s+[A-Za-z\s]+?)\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s+([\s\S]*?)EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)"?([A-Za-z0-9_.]+)"?\s*\(/gi,
      sql,
    )) {
      const [, name, when, table, middle, fn] = m;
      // `BEFORE UPDATE OF role ON t`: the event clause captured above stops just
      // before the ON, so the column list is whatever follows `UPDATE OF` to the end.
      const ofMatch = /\bUPDATE\s+OF\s+([^\s].*)$/i.exec(when);
      const cmdMatch = /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.exec(when);
      const body = functionBody(sql, fn);
      triggers.push({
        name,
        table,
        command: cmdMatch ? cmdMatch[1].toUpperCase() : "UNKNOWN",
        columns: ofMatch
          ? ofMatch[1].split(",").map((c) => c.trim().toLowerCase()).filter(Boolean)
          : null,
        fn,
        refuses: /RAISE\s+EXCEPTION/i.test(body),
        body,
        file,
        line: lineAt(sql, m.index),
      });
    }
  }
  return triggers;
}

function functionBody(sql, fn) {
  const short = fn.split(".").pop();
  const decl = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)"?${short}"?\\s*\\([^)]*\\)[\\s\\S]{0,240}?AS\\s+(\\$\\$)`,
    "i",
  ).exec(sql);
  if (!decl) return "";
  const start = decl.index + decl[0].length;
  const end = sql.indexOf(decl[1], start);
  return end === -1 ? "" : sql.slice(start, end);
}

/*
   Whether a trigger guards a column has two shapes, and this repository uses both:

     BEFORE UPDATE OF role ON profiles ...        -- the event clause names the column
     BEFORE UPDATE ON stories ...                 -- the event clause names none, and the
                                                    function refuses only when
                                                    NEW.<column> differs from OLD.<column>

   Reading only the event clause reports the second as guarding nothing, which would
   print a gap as unmitigated that the repository has in fact closed. Reading only the
   function body would be worse, since a body can mention a column and never refuse on
   it. So a column counts as guarded when the trigger refuses, and either the event
   clause lists it or the body compares NEW.<column> against OLD.<column>.
 */
function guardsColumn(trigger, column) {
  const col = column.toLowerCase();
  if (trigger.columns && trigger.columns.includes(col)) return true;
  if (trigger.columns) return false;
  return new RegExp(`NEW\\.${col}\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.${col}`, "i").test(
    trigger.body || "",
  );
}

function guardFor(row, triggers) {
  if (!row.columnGuards) return { declared: null, observed: [] };
  const observed = [];
  for (const [column, triggerName] of Object.entries(row.columnGuards)) {
    const found = triggers.find(
      (t) =>
        t.table === row.table &&
        t.command === row.command &&
        t.name === triggerName &&
        t.refuses &&
        guardsColumn(t, column),
    );
    observed.push({ column, triggerName, found: found || null });
  }
  return { declared: row.columnGuards, observed };
}

// ============================================================== checking

function apiRuleText(rule) {
  if (rule === "none") return "writer (no test)";
  if (rule === "non_admin") return "non-admin";
  return rule;
}

function rlsCellFor(row, policies) {
  const policy = policies.get(`${row.table}:${row.command}`);
  if (!policy) return { rule: "denied", lockCheck: false, policyName: null };
  return {
    rule: policy.rule,
    lockCheck: policy.lockCheck,
    policyName: policy.names.join(" + "),
    multiPolicy: policy.multiPolicy,
    restrictive: policy.restrictive,
    union: policy.union,
    file: policy.file,
  };
}

function buildModel() {
  const src = readFileSync(join(ROOT, FUNCTION_PATH), "utf8");
  const { branches, branchRanges } = parseFunction(src);
  return {
    branches,
    strays: findStrayWrites(src, branchRanges),
    policies: parsePolicies(),
    triggers: parseTriggers(),
  };
}

function note(row, message) {
  findings.info.push(`INFO              ${row.id} [${STATUS_LABEL[row.status]}] ${message}`);
}

function check() {
  findings.fail = [];
  findings.info = [];
  reported.length = 0;

  const { branches, strays, policies, triggers } = buildModel();
  const rows = [];

  const declaredApi = new Set(
    SPEC.filter((r) => r.surface === "api").map((r) => `${r.resource}:${r.action}`),
  );
  const declaredRls = new Set(
    SPEC.filter((r) => r.surface === "postgrest").map((r) => `${r.table}:${r.command}`),
  );

  const observedApi = new Map();
  for (const b of branches) {
    const key = `${b.resource}:${b.action}`;
    if (!observedApi.has(key)) observedApi.set(key, b);
  }
  const observedRls = new Map();
  for (const [key, p] of policies) {
    if (MUTATING_COMMANDS.includes(key.split(":")[1])) observedRls.set(key, p);
  }

  for (const b of branches) {
    const key = `${b.resource}:${b.action}`;
    if (!b.mutates || declaredApi.has(key)) continue;
    findings.fail.push(
      `UNDECLARED ACTION  ${key} mutates at ${FUNCTION_PATH}:${b.line} and has no row in the authorization spec. Say who may call it.`,
    );
  }
  for (const [key, p] of observedRls) {
    if (declaredRls.has(key)) continue;
    findings.fail.push(
      `UNDECLARED POLICY  ${p.names.join(" + ")} authorizes ${key} at ${MIGRATIONS_DIR}/${p.file} and has no row in the authorization spec. Say who may call it.`,
    );
  }

  // Writes the branch table cannot describe: outside every `if (resource === ...)`
  // and `if (action === ...)` body. Each one has to be declared with a reason, so
  // the coverage boundary is written down rather than assumed.
  const seenStrays = new Set();
  for (const stray of strays) {
    const match = OUT_OF_BRANCH_WRITES.find(
      (w) => w.table === stray.table && stray.stmt.includes(w.marker),
    );
    if (match) {
      seenStrays.add(match.id);
      continue;
    }
    findings.fail.push(
      `UNDECLARED WRITE   ${FUNCTION_PATH}:${stray.line} calls ${stray.call.trim()} outside every resource/action branch, and no OUT_OF_BRANCH_WRITES row claims it. Say who may reach it, or say why it is not an authorisation surface.`,
    );
  }
  for (const w of OUT_OF_BRANCH_WRITES) {
    if (!seenStrays.has(w.id)) {
      findings.fail.push(
        `STALE ROW         out-of-branch write ${w.id} is declared in the spec but ${FUNCTION_PATH} no longer makes that call. Delete the row.`,
      );
    }
  }

  for (const row of SPEC) {
    const entry = {
      row,
      observedRule: null,
      observedLock: false,
      rls: null,
      line: null,
      agree: null,
      guards: null,
    };
    let observedRule;
    let observedLock;

    if (row.surface === "api") {
      const branch = observedApi.get(`${row.resource}:${row.action}`);
      if (!branch) {
        findings.fail.push(
          `STALE ROW         ${row.id} declares ${row.resource} ${row.action}, which is no longer a branch in ${FUNCTION_PATH}. Delete the row.`,
        );
        entry.observedRule = "absent";
        rows.push(entry);
        continue;
      }
      observedRule = branch.functionRule;
      observedLock = branch.functionLockCheck;
      entry.line = branch.line;
      entry.rls = rlsCellFor(row, policies);
      entry.guards = guardFor(row, triggers);
      if (observedRule === "unknown") {
        findings.fail.push(
          `UNREADABLE GUARD  ${row.id} has a role test at ${FUNCTION_PATH}:${branch.line} this file does not recognise, so it cannot say what the branch enforces. Add the pattern or replace the test.`,
        );
        entry.agree = "unknown";
      } else {
        entry.agree = entry.rls.rule === canonical(observedRule) ? "yes" : "NO";
      }
    } else {
      const policy = observedRls.get(`${row.table}:${row.command}`);
      if (!policy) {
        findings.fail.push(
          `STALE ROW         ${row.id} declares policy ${row.policy} on ${row.table} ${row.command}, which no migration creates any more. Delete the row.`,
        );
        entry.observedRule = "absent";
        rows.push(entry);
        continue;
      }
      observedRule = policy.rule;
      observedLock = policy.lockCheck;
      entry.rls = { ...rlsCellFor(row, policies), file: policy.file };
      entry.guards = guardFor(row, triggers);
      entry.agree = "n/a";
    }

    entry.observedRule = observedRule;
    entry.observedLock = observedLock;
    rows.push(entry);

    const drift = [];
    if (row.functionRule !== undefined && canonical(observedRule) !== row.functionRule) {
      drift.push(`spec says the function requires ${row.functionRule}, code requires ${observedRule}`);
    }
    if (row.rlsRule !== undefined && observedRule !== row.rlsRule) {
      drift.push(`spec says ${row.policy} allows ${row.rlsRule}, the policies allow ${observedRule}`);
    }
    if (row.functionLockCheck !== undefined && observedLock !== row.functionLockCheck) {
      drift.push(`spec says lock check ${row.functionLockCheck}, the code says ${observedLock}`);
    }

    // More than one permissive policy for a command, or a restrictive one, means the
    // effective rule is a union this file will not guess at.
    if (entry.rls && (entry.rls.multiPolicy || entry.rls.restrictive)) {
      const why = entry.rls.restrictive
        ? "a restrictive policy is present, which this file does not model"
        : `${entry.rls.policyName} are two policies for one command and Postgres OR-s them`;
      const detail = `${why}; union admits ${entry.rls.union.join(", ")}`;
      if (row.status === "settled") {
        findings.fail.push(
          `UNRESOLVABLE RULE  ${row.id} is marked settled but ${detail}. A row is only settled on a rule this file read itself.`,
        );
      } else {
        note(row, `${detail}.`);
      }
    } else if (observedRule === "unknown") {
      if (row.status === "settled") {
        findings.fail.push(
          `UNRESOLVABLE RULE  ${row.id} is marked settled but the policy expression is not a rule this file recognises.`,
        );
      } else {
        note(row, "the policy expression is not a rule this file recognises.");
      }
    }

    // A declared guard trigger has to be there. This one fails whatever the status,
    // because the row is asserting that a mitigation exists.
    if (entry.guards && entry.guards.declared) {
      for (const g of entry.guards.observed) {
        if (g.found) continue;
        findings.fail.push(
          `MISSING GUARD     ${row.id} declares that ${g.triggerName} refuses a change to ${row.table}.${g.column}. No BEFORE ${row.command} trigger on ${row.table} with that name refuses that column.`,
        );
      }
    }

    if (row.status === "settled") {
      for (const d of drift) findings.fail.push(`DRIFT             ${row.id}: ${d}.`);
      if (row.surface === "api" && entry.agree === "NO") {
        findings.fail.push(
          `SURFACE MISMATCH  ${row.id} is marked settled, but the function requires ${apiRuleText(observedRule)} while PostgREST allows ${entry.rls.rule} (\`${entry.rls.policyName}\`). Settle it, or move it to known_gap and carry a ticket.`,
        );
      }
    } else {
      for (const d of drift) note(row, `the recorded state changed: ${d}.`);
    }

    // Every row that is not settled says so on every run, whatever surface it is on.
    // A gap that only prints for one of the two surfaces is a gap that goes quiet.
    if (REPORTED_STATUSES.includes(row.status)) {
      reported.push(row.id);
      const guardNames = entry.guards && entry.guards.declared
        ? [...new Set(Object.values(entry.guards.declared))].join(", ")
        : null;
      const guardText = guardNames
        ? `; guard \`${guardNames}\` ${entry.guards.observed.every((g) => g.found) ? "present" : "MISSING"}`
        : "";
      if (row.surface === "api") {
        note(
          row,
          `function requires ${apiRuleText(observedRule)}, PostgREST allows ${entry.rls ? entry.rls.rule : "n/a"} (${entry.rls ? entry.rls.policyName : "n/a"})${guardText}.`,
        );
      } else {
        note(
          row,
          `PostgREST allows ${observedRule} (${entry.rls ? entry.rls.policyName : "n/a"})${guardText}.`,
        );
      }
    }
  }

  /*
   The reporting path is itself asserted, so a gap cannot stop printing.

   The expectation is derived from `status !== "settled"` and not from
   REPORTED_STATUSES, which gates the reporting. Deriving both sides from the same
   list makes the assertion circular: dropping a status from that list stops the
   report and shrinks the expectation in the same edit, and the check passes with a
   gap it no longer prints. Deriving the expectation from the spec means that edit
   fails instead, which is the property being asserted.

   An unrecognised status is a failure for the same reason. A typo in a status string
   matches no gate at all, so the row is silently treated as settled and never
   printed.
  */
  const expected = SPEC.filter((r) => r.status !== "settled").map((r) => r.id);
  if (reported.length !== expected.length || reported.some((id, i) => id !== expected[i])) {
    findings.fail.push(
      `QUIET GAP         ${expected.length} rows are not settled but ${reported.length} were reported. A recorded gap that does not print is worse than one that fails, because it looks closed.`,
    );
  }
  for (const row of SPEC) {
    if (!STATUS_LABEL[row.status]) {
      findings.fail.push(
        `UNKNOWN STATUS    ${row.id} has status "${row.status}", which is not one of ${Object.keys(STATUS_LABEL).join(", ")}. A status that matches no gate is treated as settled and never reported.`,
      );
    }
  }

  const docPath = join(ROOT, DOC_PATH);
  if (existsSync(docPath)) {
    if (readFileSync(docPath, "utf8").trimEnd() !== renderDoc(rows).trimEnd()) {
      findings.fail.push(
        `STALE DOC         ${DOC_PATH} does not match what the spec generates. Run \`npm run authz:doc\`.`,
      );
    }
  } else {
    findings.fail.push(`MISSING DOC       ${DOC_PATH} does not exist. Run \`npm run authz:doc\`.`);
  }

  return { rows, model: { branches, strays, policies, triggers } };
}

// ============================================================== the document

function renderDoc(rows) {
  const header = readFileSync(join(ROOT, DOC_HEADER_PATH), "utf8").trimEnd();
  const footer = readFileSync(join(ROOT, DOC_FOOTER_PATH), "utf8").trimEnd();
  const out = [header, ""];

  out.push("## Every mutating action");
  out.push("");
  out.push("| Action | Function (`bcn_` key path) | PostgREST (RLS) | Trigger | Agree | Status |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const e of rows) {
    const label = `\`${e.row.id}\``;
    if (e.observedRule === "absent") {
      out.push(`| ${label} | _absent from the code_ | | | | ${STATUS_LABEL[e.row.status]} |`);
      continue;
    }
    const fnMark = e.observedLock ? " + lock check" : "";
    const pgMark = e.rls && e.rls.lockCheck ? " + lock check" : "";
    const fn = e.row.surface === "api" ? `${apiRuleText(e.observedRule)}${fnMark}` : "--";
    let pg = e.rls ? `${e.rls.rule}${pgMark}${e.rls.policyName ? ` (\`${e.rls.policyName}\`)` : ""}` : "--";
    if (e.rls && (e.rls.multiPolicy || e.rls.restrictive)) {
      pg += ` — union: ${e.rls.union.join(", ")}`;
    }
    const guardText =
      e.guards && e.guards.declared
        ? Object.entries(e.guards.declared)
            .map(([col, name]) => `${name} (${col})`)
            .join(", ")
        : "--";
    const agree =
      e.agree === "NO" ? "**no**" : e.agree === "n/a" ? "n/a" : e.agree === "unknown" ? "?" : "yes";
    out.push(
      `| ${label} | ${fn} | ${pg} | ${guardText} | ${agree} | ${STATUS_LABEL[e.row.status]} |`,
    );
  }

  out.push("");
  out.push("## Notes per row");
  out.push("");
  for (const e of rows) {
    if (e.observedRule === "absent") continue;
    out.push(`- **\`${e.row.id}\`** — ${e.row.note}`);
    if (e.row.editorialRef) out.push(`  Editorial gate: ${e.row.editorialRef}`);
  }
  out.push("");
  out.push(footer);
  out.push("");
  return out.join("\n");
}

// ============================================================== entry point

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--write-doc")) {
    const { rows } = check();
    writeFileSync(join(ROOT, DOC_PATH), renderDoc(rows));
    process.stdout.write(`wrote ${DOC_PATH}\n`);
    return 0;
  }
  if (args.includes("--print")) {
    const { rows } = check();
    process.stdout.write(renderDoc(rows));
    return 0;
  }

  const { rows, model } = check();

  if (args.includes("--debug")) {
    process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    return 0;
  }

  const count = (s) => rows.filter((r) => r.row.status === s).length;

  process.stdout.write(
    `API authorization check  (${FUNCTION_PATH} + ${MIGRATIONS_DIR}/*.sql)\n\n`,
  );
  process.stdout.write(
    `  ${rows.length} rows: ${count("settled")} settled, ${count("known_gap")} known gaps, ` +
      `${count("mitigated_unapplied")} mitigated-unapplied, ${count("editorially_gated")} editorially gated\n` +
      `  ${model.triggers.length} trigger(s), ${model.strays.length} write(s) outside every branch, ` +
      `${model.branches.length} branch(es)\n\n`,
  );

  for (const line of findings.info) process.stdout.write(`  ${line}\n`);
  if (findings.info.length) process.stdout.write("\n");

  if (findings.fail.length) {
    for (const line of findings.fail) process.stdout.write(`  ${line}\n`);
    process.stdout.write(
      `\n  FAIL  ${findings.fail.length} problem${findings.fail.length === 1 ? "" : "s"}.\n`,
    );
    return 1;
  }

  process.stdout.write("  PASS  The code matches the authorization table.\n\n");
  return 0;
}

process.exit(main());