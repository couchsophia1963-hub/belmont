#!/usr/bin/env node
/*
 Check the code against `api-authorization-spec.mjs`.

 No dependencies, no network, no database. It reads two things as text:
 `supabase/functions/api/index.ts` and `supabase/migrations/*.sql`, works out what
 each mutating action is actually allowed to do today, and compares that against
 what the spec claims.

 Exit 0 clean, exit 1 on a failure. `--print` writes the generated document to
 stdout, `--write-doc` rewrites docs/api-authorization.md from the spec.

 Added on BEL-235, where the same defect was found three times by three people
 reading the function action by action. The point of this file is to make the
 fourth occurrence a build failure rather than a discovery.
*/

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEC,
  DOC_PATH,
  DOC_HEADER_PATH,
  DOC_FOOTER_PATH,
  FUNCTION_PATH,
  MIGRATIONS_DIR,
} from "./api-authorization-spec.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MUTATING_COMMANDS = ["INSERT", "UPDATE", "DELETE"];
const STATUS_LABEL = {
  settled: "settled",
  known_gap: "KNOWN GAP",
  editorially_gated: "EDITORIAL",
};

const findings = { fail: [], info: [] };

/*
 A brace counter that is not fooled by braces inside strings, template literals or
 comments. The function nests `if (action === "delete") {` inside
 `if (resource === "stories") {`, so block boundaries are load-bearing here.
*/
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
  return "none";
}

function mutates(src) {
  return /\.(insert|update|delete|upsert)\s*\(/.test(src);
}

function lockChecked(src) {
  return /select\(\s*"locked"/.test(src) && /\.locked\b/.test(src);
}

/*
 Walk the function's resource blocks, then the action branches inside each, and
 record what each branch actually enforces. `action === "upsert" || action ===
 "create"` is one branch serving two actions, so a shared branch yields two entries
 with the same enforcement.
*/
function parseFunction(src) {
  const branches = [];
  for (const r of all(/if\s*\(\s*resource\s*===\s*"([a-z]+)"\s*\)/g, src)) {
    const block = blockAfter(src, r.index + r[0].length);
    if (!block) continue;
    for (const a of all(/if\s*\(\s*action\s*===\s*"([a-z]+)"([^)]*)\)\s*\{/g, block.body)) {
      const openInBlock = block.body.indexOf("{", a.index + a[0].length - 1);
      const branch = blockAfter(block.body, openInBlock);
      if (!branch) continue;
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
  return branches;
}

/*
 CREATE POLICY and DROP POLICY in file order, with the later migration replacing the
 earlier one the same way the database applies them. Statements are merged by
 position so a DROP followed by a CREATE of the same name inside one file leaves the
 policy live, which is the normal shape of these migrations.
*/
function parsePolicies() {
  const files = readdirSync(join(ROOT, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const live = new Map();

  for (const file of files) {
    const sql = readFileSync(join(ROOT, MIGRATIONS_DIR, file), "utf8");
    const statements = [];

    for (const d of all(
      /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?/gi,
      sql,
    )) {
      statements.push({ index: d.index, kind: "drop", name: d[1], table: d[2], match: d });
    }

    for (const c of all(
      /CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([A-Za-z0-9_,"' ]+?)\s+(WITH\s+CHECK|USING)/gi,
      sql,
    )) {
      statements.push({
        index: c.index,
        kind: "create",
        name: c[1],
        table: c[2],
        cmd: c[3].toUpperCase(),
        roles: c[4].trim(),
        tailAt: c.index + c[0].length,
        keyword: c[5].replace(/\s+/g, " "),
        match: c,
      });
    }

    statements.sort((a, b) => a.index - b.index);

    for (const s of statements) {
      if (s.kind === "drop") {
        for (const [key, p] of [...live]) {
          if (p.name === s.name && p.table === s.table) live.delete(key);
        }
        continue;
      }
      const first = new RegExp(`^\\s*${s.keyword}\\s*\\(`).exec(sql.slice(s.tailAt));
      const exprStart = s.tailAt + (first ? first[0].length - 1 : 0);
      const firstExpr = parenBody(sql, exprStart);
      const second = /\)\s*(WITH\s+CHECK|USING)\s*\(/.exec(sql.slice(exprStart));
      let secondExpr = "";
      if (second) {
        secondExpr = parenBody(sql, exprStart + second.index + second[0].length - 1);
      }
      const commands = s.cmd === "ALL" ? MUTATING_COMMANDS.concat("SELECT") : [s.cmd];
      for (const cmd of commands) {
        live.set(`${s.table}:${cmd}`, {
          name: s.name,
          table: s.table,
          cmd,
          roles: s.roles,
          expr: firstExpr,
          expr2: secondExpr,
          file,
          line: lineAt(sql, s.index),
        });
      }
    }
  }

  const out = new Map();
  for (const [key, p] of live) {
    const expr = `${p.expr} ${p.expr2}`;
    out.set(key, {
      ...p,
      rule: classifyRule(expr),
      lockCheck: /locked\s*=\s*false/.test(expr),
    });
  }
  return out;
}

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
    policyName: policy.name,
    line: policy.line,
    file: policy.file,
  };
}

function buildModel() {
  return {
    branches: parseFunction(readFileSync(join(ROOT, FUNCTION_PATH), "utf8")),
    policies: parsePolicies(),
  };
}

function check() {
  findings.fail = [];
  findings.info = [];
  const { branches, policies } = buildModel();
  const rows = [];

  const specApi = SPEC.filter((r) => r.surface === "api");
  const specRls = SPEC.filter((r) => r.surface === "postgrest");
  const declaredApi = new Set(specApi.map((r) => `${r.resource}:${r.action}`));
  const declaredRls = new Set(specRls.map((r) => `${r.table}:${r.command}`));

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
    if (!b.mutates) continue;
    if (declaredApi.has(key)) continue;
    findings.fail.push(
      `UNDECLARED ACTION  ${key} mutates at ${FUNCTION_PATH}:${b.line} and has no row in the authorization spec. Say who may call it.`,
    );
  }
  for (const [key, p] of observedRls) {
    if (declaredRls.has(key)) continue;
    findings.fail.push(
      `UNDECLARED POLICY  ${p.name} authorizes ${key} at ${MIGRATIONS_DIR}/${p.file}:${p.line} and has no row in the authorization spec. Say who may call it.`,
    );
  }

  for (const row of SPEC) {
    const entry = { row, observedRule: null, observedLock: false, rls: null, line: null, agree: null };
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
      entry.agree = entry.rls.rule === canonical(observedRule) ? "yes" : "NO";
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
      entry.rls = { ...rlsCellFor(row, policies), line: policy.line };
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
      drift.push(
        `spec says ${row.policy} allows ${row.rlsRule}, the policy allows ${observedRule}`,
      );
    }
    if (row.functionLockCheck !== undefined && observedLock !== row.functionLockCheck) {
      drift.push(`spec says lock check ${row.functionLockCheck}, the code says ${observedLock}`);
    }

    if (row.status === "settled") {
      for (const d of drift) findings.fail.push(`DRIFT             ${row.id}: ${d}.`);
      if (row.surface === "api" && entry.agree === "NO") {
        findings.fail.push(
          `SURFACE MISMATCH  ${row.id} is marked settled, but the function requires ${apiRuleText(observedRule)} while PostgREST allows ${entry.rls.rule} (\`${entry.rls.policyName}\`). Settle it, or move it to known_gap and carry a ticket.`,
        );
      }
    } else {
      for (const d of drift) {
        findings.info.push(
          `INFO              ${row.id} [${STATUS_LABEL[row.status]}] the recorded state changed: ${d}. The gap may have closed, or the spec is stale.`,
        );
      }
      if (row.surface === "api") {
        findings.info.push(
          `KNOWN             ${row.id} [${STATUS_LABEL[row.status]}] function requires ${apiRuleText(observedRule)}, PostgREST allows ${entry.rls.rule}.`,
        );
      }
    }
  }

  if (existsSync(join(ROOT, DOC_PATH))) {
    const onDisk = readFileSync(join(ROOT, DOC_PATH), "utf8").trimEnd();
    if (onDisk !== renderDoc(rows).trimEnd()) {
      findings.fail.push(
        `STALE DOC         ${DOC_PATH} does not match what the spec generates. Run \`npm run authz:doc\`.`,
      );
    }
  } else {
    findings.fail.push(`MISSING DOC       ${DOC_PATH} does not exist. Run \`npm run authz:doc\`.`);
  }

  return { rows };
}

function renderDoc(rows) {
  const header = readFileSync(join(ROOT, DOC_HEADER_PATH), "utf8").trimEnd();
  const footer = readFileSync(join(ROOT, DOC_FOOTER_PATH), "utf8").trimEnd();
  const out = [header, ""];

  out.push("## Every mutating action");
  out.push("");
  out.push(
    "| Action | Function (`bcn_` key path) | PostgREST (RLS) | Agree | Status |",
  );
  out.push("| --- | --- | --- | --- | --- |");
  for (const e of rows) {
    const label = `\`${e.row.id}\``;
    if (e.observedRule === "absent") {
      out.push(`| ${label} | _absent from the code_ | | | ${STATUS_LABEL[e.row.status]} |`);
      continue;
    }
    const fnMark = e.observedLock ? " + lock check" : "";
    const pgMark = e.rls && e.rls.lockCheck ? " + lock check" : "";
    const fn = e.row.surface === "api" ? `${apiRuleText(e.observedRule)}${fnMark}` : "--";
    const pg = e.rls ? `${e.rls.rule}${pgMark}${e.rls.policyName ? ` (\`${e.rls.policyName}\`)` : ""}` : "--";
    const agree = e.agree === "NO" ? "**no**" : e.agree === "n/a" ? "n/a" : "yes";
    out.push(`| ${label} | ${fn} | ${pg} | ${agree} | ${STATUS_LABEL[e.row.status]} |`);
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

  const { rows } = check();
  const count = (s) => rows.filter((r) => r.row.status === s).length;

  process.stdout.write(`API authorization check  (${FUNCTION_PATH} + ${MIGRATIONS_DIR}/*.sql)\n\n`);
  process.stdout.write(
    `  ${rows.length} rows: ${count("settled")} settled, ${count("known_gap")} known gaps, ` +
      `${count("editorially_gated")} editorially gated\n\n`,
  );

  for (const line of findings.info) process.stdout.write(`  ${line}\n`);
  if (findings.info.length) process.stdout.write("\n");

  if (findings.fail.length) {
    for (const line of findings.fail) process.stdout.write(`  ${line}\n`);
    process.stdout.write(`\n  FAIL  ${findings.fail.length} problem${findings.fail.length === 1 ? "" : "s"}.\n`);
    return 1;
  }

  process.stdout.write("  PASS  The code matches the authorization table.\n\n");
  return 0;
}

process.exit(main());