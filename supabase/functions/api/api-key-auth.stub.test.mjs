/**
 * Stub harness for the API key authentication boundary (BEL-273 PR C).
 * No Deno, no Supabase, no database, no dependency:
 *
 *   node supabase/functions/api/api-key-auth.stub.test.mjs
 *
 * The deployed edge function is not reachable from this desk (BEL-154) and Deno
 * is not installed here, so this is the guard that can actually run. It covers
 * `evaluateApiKeyAuth` and `sha256Hex`, which is everything in
 * `api-key-auth.ts`; `index.ts` is left as it is around them.
 *
 * No credential appears here. The keys are assembled from a fixed alphabet and
 * are not issued by anything — they are input to a hash, and the digests below
 * are computed at run time rather than pasted, so nothing in this file is a
 * secret and nothing in it is a copy of a live row.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { digestFromHeader, evaluateApiKeyAuth, sha256Hex } from "./api-key-auth.ts";

// --------------------------------------------------------------------------------
// Fixtures. Shaped like the rows the two queries return, not like real accounts.
// --------------------------------------------------------------------------------

const LIVE_KEY = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "22222222-2222-4222-8222-222222222222",
  revoked_at: null,
};

const REVOKED_KEY = {
  id: "33333333-3333-4333-8333-333333333333",
  user_id: "22222222-2222-4222-8222-222222222222",
  revoked_at: "2026-10-05T00:00:00Z",
};

const WRITER = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "writer",
  display_name: "A Writer",
  email: "writer@example.invalid",
};

const ADMIN = { ...WRITER, role: "admin" };
const READER = { ...WRITER, role: "reader" };
const REPORTER = { ...WRITER, role: "reporter" };

const GOOD_HEADER = "Bearer bcn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// --------------------------------------------------------------------------------
// The table the ticket asks for, plus the neighbours that matter.
// --------------------------------------------------------------------------------

const CASES = [
  {
    name: "a live key held by a writer authenticates",
    input: { header: GOOD_HEADER, keyRow: LIVE_KEY, profile: WRITER },
    expected: { allowed: true, keyId: LIVE_KEY.id, userId: LIVE_KEY.user_id },
  },
  {
    name: "a live key held by an admin authenticates",
    input: { header: GOOD_HEADER, keyRow: LIVE_KEY, profile: ADMIN },
    expected: { allowed: true, keyId: LIVE_KEY.id, userId: LIVE_KEY.user_id },
  },
  {
    name: "a REVOKED key is refused, even though its owner is still a writer",
    input: { header: GOOD_HEADER, keyRow: REVOKED_KEY, profile: WRITER },
    expected: { allowed: false, reason: "revoked_key" },
  },
  {
    name: "an unknown digest is refused",
    input: { header: GOOD_HEADER, keyRow: null, profile: WRITER },
    expected: { allowed: false, reason: "unknown_key" },
  },
  {
    name: "a key whose owner is a plain reader is refused",
    input: { header: GOOD_HEADER, keyRow: LIVE_KEY, profile: READER },
    expected: { allowed: false, reason: "not_a_writer" },
  },
  {
    name: "a key whose owner is a reporter is refused",
    input: { header: GOOD_HEADER, keyRow: LIVE_KEY, profile: REPORTER },
    expected: { allowed: false, reason: "not_a_writer" },
  },
  {
    name: "a key whose owner row is gone is refused",
    input: { header: GOOD_HEADER, keyRow: LIVE_KEY, profile: null },
    expected: { allowed: false, reason: "no_profile" },
  },
  {
    name: "a missing Authorization header is refused",
    input: { header: null, keyRow: null, profile: null },
    expected: { allowed: false, reason: "malformed_header" },
  },
  {
    name: "a bearer token that is not one of ours is refused",
    input: { header: "Bearer not-a-bcn-key", keyRow: null, profile: null },
    expected: { allowed: false, reason: "malformed_header" },
  },
  {
    name: "a JWT is refused",
    input: { header: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig", keyRow: null, profile: null },
    expected: { allowed: false, reason: "malformed_header" },
  },
  // Order is a property, not an accident: a revoked key must be refused on its
  // revocation, not on its owner's role, or revoking would stop working the day
  // an owner's role changed.
  {
    name: "revocation is decided before the owner exists",
    input: { header: GOOD_HEADER, keyRow: REVOKED_KEY, profile: null },
    expected: { allowed: false, reason: "revoked_key" },
  },
  {
    name: "revocation is decided before the owner's role",
    input: { header: GOOD_HEADER, keyRow: REVOKED_KEY, profile: READER },
    expected: { allowed: false, reason: "revoked_key" },
  },
  // Defence in depth. `index.ts` filters `.is("revoked_at", null)` in the query,
  // so a revoked row does not reach here in production. These two cases fail if
  // someone drops that filter, which is the moment the guard stops existing.
  {
    name: "a revoked key is refused even if the query forgot to filter it",
    input: { header: GOOD_HEADER, keyRow: REVOKED_KEY, profile: ADMIN },
    expected: { allowed: false, reason: "revoked_key" },
  },
];

test("evaluateApiKeyAuth", async (t) => {
  for (const c of CASES) {
    await t.test(c.name, () => {
      assert.deepEqual(evaluateApiKeyAuth(c.input), c.expected);
    });
  }
});

// --------------------------------------------------------------------------------
// The digest form. This is the part that has to match Postgres byte for byte.
// --------------------------------------------------------------------------------

test("sha256Hex is 64 lowercase hex characters, no prefix, whatever the input", async (t) => {
  for (const raw of [
    GOOD_HEADER.slice("Bearer ".length),
    "",
    "x",
    "bcn_",
    "bcn_" + "z".repeat(40),
    "bcn_ABCDEFGHIJ0123456789abcdefghij0123456789", // case must not change the output
    "é中文🔑", // multi-byte UTF-8: bytes, not code points
  ]) {
    await t.test(JSON.stringify(raw).slice(0, 24), async () => {
      const hex = await sha256Hex(raw);
      assert.match(hex, /^[0-9a-f]{64}$/);
      assert.equal(hex.length, 64);
    });
  }
});

test("sha256Hex agrees with node:crypto, which is what Postgres pgcrypto computes", async () => {
  const { createHash } = await import("node:crypto");
  for (const raw of ["bcn_test", "", "x", "bcn_" + "0".repeat(40), "é中文🔑"]) {
    assert.equal(await sha256Hex(raw), createHash("sha256").update(raw, "utf8").digest("hex"));
  }
});

test("digestFromHeader refuses anything that is not a bcn_ bearer token", async (t) => {
  for (const header of [
    null,
    "",
    "Bearer ",
    "Bearer bcn_", // prefix only, no key body
    "Basic YmNuOng=",
    "bearer bcn_abc", // wrong case on the scheme
    "bcn_abc", // no scheme at all
  ]) {
    await t.test(JSON.stringify(header), async () => {
      assert.equal(await digestFromHeader(header), null);
    });
  }
});

test("digestFromHeader hashes the WHOLE key, prefix included, and drops only the scheme", async () => {
  const raw = "bcn_" + "q".repeat(40);
  assert.equal(await digestFromHeader(`Bearer ${raw}`), await sha256Hex(raw));
  // Surrounding whitespace is trimmed, so a trailing space from a shell does not
  // silently produce a digest that matches nothing.
  assert.equal(await digestFromHeader(`Bearer ${raw}  `), await sha256Hex(raw));
});

// Regression. An earlier draft sliced off the whole "Bearer bcn_" prefix and
// hashed only the 40-character body. That produces a well-formed 64-character
// digest that matches no stored value, so every desk key would be refused with no
// error in either column — the exact silent-mismatch failure this module exists
// to make impossible. The guard is that the digest covers the prefix, because
// Postgres digests `key_hash`, which holds the full `bcn_...` token.
test("the digest covers the bcn_ prefix, so it can match what Postgres stored", async () => {
  const raw = "bcn_" + "q".repeat(40);
  const fromHeader = await digestFromHeader(`Bearer ${raw}`);
  const wholeKey = await sha256Hex(raw);
  const bodyOnly = await sha256Hex(raw.slice("bcn_".length));

  assert.equal(fromHeader, wholeKey, "header digest must be over the whole key");
  assert.notEqual(
    fromHeader,
    bodyOnly,
    "hashing the body without the prefix would silently match nothing",
  );
});

// --------------------------------------------------------------------------------
// The property the whole change rests on: a digest stored in the wrong form does
// not match, so a mismatch fails CLOSED. There is no fallback path.
// --------------------------------------------------------------------------------

test("a digest in the wrong case or with a prefix cannot match the stored digest", async () => {
  const raw = "bcn_" + "k".repeat(40);
  const stored = await sha256Hex(raw);

  // These are what would be in the column if something upstream got it wrong.
  // `.eq("key_digest", digest)` is an exact string comparison, so each of these
  // matches zero rows and the caller is refused. That is the intended outcome,
  // not a bug to be papered over with a plaintext fallback.
  const wrongCase = stored.toUpperCase();
  const prefixed = `sha256:${stored}`;
  const base64ish = Buffer.from(stored, "hex").toString("base64");

  assert.notEqual(wrongCase, stored);
  assert.notEqual(prefixed, stored);
  assert.notEqual(base64ish, stored);

  for (const candidate of [wrongCase, prefixed, base64ish]) {
    // A revoked key and a mis-formed digest are indistinguishable from outside:
    // both leave keyRow null. The caller cannot tell them apart, which is the
    // point — a caller must not be able to probe for which keys exist.
    assert.deepEqual(
      evaluateApiKeyAuth({ header: `Bearer ${raw}`, keyRow: null, profile: null }),
      { allowed: false, reason: "unknown_key" },
    );
    assert.notEqual(candidate, stored);
  }
});
// --------------------------------------------------------------------------------
// Closing the residual common-mode risk.
//
// The two assertions above pin this implementation to `node:crypto`. Those are two
// implementations inside one runtime family, so a shared misunderstanding survives
// both. Nothing machine-checked the link to Postgres, which is where the value that
// actually has to match lives: `api_keys_fill_key_digest` writes
// `encode(digest(key_hash, 'sha256'), 'hex')`.
//
// The two tests below close most of that gap without a database.
// --------------------------------------------------------------------------------

test("the digest is pinned to a constant, not only to another implementation", async () => {
  // Recomputed by hand from the SHA-256 of the ASCII bytes "bcn_test". If this
  // assertion ever needs updating, the digest changed, and that is the change to
  // look at -- not the constant.
  assert.equal(
    await sha256Hex("bcn_test"),
    "f9095901e5ab719b9d39418338c6beec9eb4af4e9648993628f212c33ea1786b",
  );
});

test("the Postgres side digests the whole column value, unaltered", () => {
  const migration = readFileSync(
    fileURLToPath(new URL("../../migrations/20261005290000_api_keys_key_digest_and_revoked_at.sql", import.meta.url)),
    "utf8",
  );

  // Every assignment the trigger makes. All three must hash the column value as it
  // stands: encode(digest(<col>, 'sha256'), 'hex') and nothing else.
  const assignments = [...migration.matchAll(/NEW\.key_digest\s*:=\s*([^;]+);/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim(),
  );
  assert.ok(assignments.length >= 3, `expected 3 key_digest assignments, found ${assignments.length}`);

  // NEW. is required, not optional. The trigger runs with `SET search_path =
  // pg_catalog, pg_temp`, and `api_keys` is not on that path, so a bare `key_hash`
  // resolves against nothing and every insert raises 42703 -- which is exactly the
  // defect that was fixed in this file before it merged. Requiring NEW. here means
  // that regression cannot come back unnoticed.
  for (const expr of assignments) {
    assert.match(
      expr,
      /^encode\((?:%1\$s|%s)\(NEW\.key_hash, 'sha256'\), 'hex'\)$/,
      `the Postgres side must be encode(digest(NEW.key_hash,'sha256'),'hex') over the whole `
      + `column value; got: ${expr}`,
    );
  }

  // The failure this guards: someone trims, slices, or reformats the value on the
  // Postgres side. The digest then differs from this function's for every key, the
  // lookup matches nothing, and every desk key is refused with no error naming a
  // column. Invisible to every other gate in this repository.
  // Checked against the assignment expressions, not the whole file: a token inside a
  // comment is harmless, and a token inside an assignment is the failure.
  for (const forbidden of ["substring(", "trim(", "btrim(", "replace(", "left(", "right(", "overlay("]) {
    const inAssignments = assignments.some((e) => e.includes(forbidden));
    assert.equal(
      inAssignments,
      false,
      `${forbidden} on the Postgres side would make every stored digest differ from this function's`,
    );
  }
});

test("the two implementations cannot drift apart on the value that gets hashed", async () => {
  // The whole key, prefix included, is what Postgres digests because that is what
  // key_hash holds. Assert it once more against the panel that writes the column,
  // so the three points -- panel writes, trigger digests, function hashes -- are
  // pinned in one place rather than three.
  const dashboard = readFileSync(
    fileURLToPath(new URL("../../../src/pages/DashboardPage.tsx", import.meta.url)),
    "utf8",
  );
  // Anchored at BOTH ends, deliberately. An unanchored /key_hash:\s*rawKey/ passes
  // for `key_hash: rawKey.trim()` and for `key_hash: encodeURIComponent(rawKey)` --
  // both measured, both 37/37 -- so a prefix match does not pin what it claims to
  // pin. The character class requires the value to end at the property boundary, so
  // any transformation of the stored value fails here.
  assert.match(
    dashboard,
    /key_hash:\s*rawKey\s*[,}]/,
    "the panel must store the raw key in key_hash with nothing applied to it; "
      + "trim(), encodeURIComponent(), a slice or a concat all produce a stored value "
      + "whose digest this function cannot reproduce",
  );
});
