/**
 * The API key authentication decision, kept free of Deno and of Supabase so the
 * stub harness beside it can exercise it with plain Node
 * (`node supabase/functions/api/api-key-auth.stub.test.mjs`).
 *
 * `index.ts` is the only production caller. This file owns two things the edge
 * function must not get wrong:
 *
 *   1. `sha256Hex` — the digest form, which has to agree with Postgres byte for
 *      byte or nothing authenticates.
 *   2. `evaluateApiKeyAuth` — who a bearer token may act as, and why not.
 *
 * Split out because both are pure decisions and both fail closed. A digest
 * mismatch and a revoked key look identical from the outside — the caller is
 * refused — which is the correct behaviour and the reason they are hard to
 * review by reading the call site.
 */

/** The HTTP auth scheme. This is transport framing and is not hashed. */
const SCHEME = "Bearer ";

/**
 * The bearer scheme the panel issues, checked as one string so a JWT or a
 * session token is refused before anything is hashed. `bcn_` is part of the key,
 * not the scheme: the whole `bcn_...` token is what gets hashed.
 */
const BEARER_PREFIX = "Bearer bcn_";

/** A row of `api_keys`, as this module needs to see it. */
export interface ApiKeyRow {
  id: string;
  user_id: string;
  /**
   * Null means live. Present means revoked.
   *
   * `authenticate()` already filters on this in the query, so in production a
   * revoked row never arrives. It is in the type anyway, and checked, so that the
   * refusal is a property of this function rather than of one string in one call
   * site — and so the "revoked key is refused" case is actually reachable by a
   * test instead of being untestable by construction.
   */
  revoked_at: string | null;
}

/** A row of `profiles`, as this module needs to see it. */
export interface KeyOwnerProfile {
  id: string;
  role: string;
  display_name: string;
  email: string;
}

export interface ApiKeyAuthInput {
  /** The raw `Authorization` header, unparsed. */
  header: string | null;
  /** The `api_keys` row the digest lookup matched, or null if none did. */
  keyRow: ApiKeyRow | null;
  /** The `profiles` row for `keyRow.user_id`, or null if there is none. */
  profile: KeyOwnerProfile | null;
}

export type ApiKeyAuthRefusal =
  | "malformed_header"
  | "unknown_key"
  | "revoked_key"
  | "no_profile"
  | "not_a_writer";

export type ApiKeyAuthDecision =
  | { allowed: true; keyId: string; userId: string }
  | { allowed: false; reason: ApiKeyAuthRefusal };

/**
 * The SHA-256 of `rawKey`, lowercase hex, no prefix, over the UTF-8 bytes.
 *
 * This is the whole point of the change and it is byte-sensitive. It must equal
 * what `encode(digest(key_hash, 'sha256'), 'hex')` returns in Postgres, which is
 * what `api_keys_fill_key_digest` writes into `key_digest`. Both are defined as
 * lowercase unprefixed hex over the same bytes, so they agree.
 *
 * They must NOT be allowed to disagree quietly. If they do, no row matches, the
 * caller is refused, and every desk key stops working with nothing in either
 * column explaining why — so there is deliberately no fallback to a plaintext
 * lookup here. A fallback would make the mismatch invisible at exactly the cost
 * it is supposed to signal, and would re-open the hole `key_digest` exists to
 * close: a comparison against `key_hash` is a plaintext equality test, which is
 * the thing being removed.
 *
 * WebCrypto is global in both runtimes — Deno in the edge function, Node in the
 * test harness — so this needs no import and the two cannot drift.
 */
export async function sha256Hex(rawKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The digest of the bearer token in `header`, or null if the header is not one
 * of ours.
 *
 * The hashed string is the WHOLE key including its `bcn_` prefix, because that
 * is what Postgres hashes: `api_keys_fill_key_digest` computes
 * `encode(digest(key_hash, 'sha256'), 'hex')` over the stored `key_hash`, and
 * `key_hash` holds the full `bcn_...` token. Hashing only the body would produce
 * a 64-character digest that is perfectly well-formed and matches nothing, so
 * every key would be refused with no error anywhere. `bcn_` is part of the secret,
 * not a transport prefix to be stripped.
 *
 * Only the `Bearer ` scheme word is removed. Separating the two is the whole
 * reason this is a function rather than a `.replace("Bearer ", "")` at the call
 * site.
 */
export async function digestFromHeader(
  header: string | null,
): Promise<string | null> {
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const rawKey = header.slice(SCHEME.length).trim();
  if (rawKey === BEARER_PREFIX.slice(SCHEME.length)) return null; // "Bearer bcn_" with no body
  return sha256Hex(rawKey);
}

/**
 * Decide whether a bearer token may act, and as whom.
 *
 * Every refusal is the same refusal to the caller — 401, no detail — so `reason`
 * is for logs and tests, not for the response. The reasons are kept apart anyway
 * because "we do not know why" is how the two bugs this file exists over got
 * shipped in the first place: a key that stopped working, and a reroll that
 * reported success and changed nothing.
 *
 * Order matters and is not incidental:
 *
 *   - header shape first, so a malformed request costs nothing;
 *   - then whether a key matched, then whether it is revoked, then whether its
 *     owner exists and may write. A revoked key is refused *before* the profile
 *     is consulted, so revocation does not depend on the owner still existing —
 *     a deleted `profiles` row must not turn a revoked key back into a live one.
 */
export function evaluateApiKeyAuth(input: ApiKeyAuthInput): ApiKeyAuthDecision {
  const { header, keyRow, profile } = input;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return { allowed: false, reason: "malformed_header" };
  }

  if (!keyRow) {
    return { allowed: false, reason: "unknown_key" };
  }

  if (keyRow.revoked_at !== null) {
    return { allowed: false, reason: "revoked_key" };
  }

  if (!profile) {
    return { allowed: false, reason: "no_profile" };
  }

  if (profile.role !== "writer" && profile.role !== "admin") {
    return { allowed: false, reason: "not_a_writer" };
  }

  return { allowed: true, keyId: keyRow.id, userId: keyRow.user_id };
}