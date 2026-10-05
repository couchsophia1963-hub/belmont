#!/usr/bin/env node
// BEL-308. The build-env gate for the app.
//
// `src/lib/supabase.ts` reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
// at module load, and Vite inlines both at build time. That makes the failure
// this file exists to stop silent:
//
//   - unset   -> `createClient(undefined, undefined)`. `vite build` succeeds,
//                the shell renders, and every read fails in the browser.
//   - wrong   -> a key that names a different project, or a revoked one, or a
//                `service_role` key. `vite build` still succeeds. The build is
//                green and the site is dark.
//
// A green build is not evidence of a working build. This gate turns the
// variables into something a build has to answer for before it is allowed to
// produce an artifact.
//
// Two modes, because they answer different questions and only one needs network:
//
//   node scripts/build-env.mjs            shape and provenance only, no network
//   node scripts/build-env.mjs --probe    additionally ask Supabase to read
//
// The split exists so CI can prove the rule on every push without a credential
// or an outbound call, while a deploy can additionally prove the key is one
// Supabase still accepts. The presence-only bash loop this replaces caught
// neither shape nor provenance.
//
// Neither mode ever prints a key. Everything about a key is reported as a
// fingerprint, the project ref, the role, and the expiry.

import { createHash } from 'node:crypto';

/** The two tables a read of this app cannot succeed without. */
export const REQUIRED_TABLES = ['stories', 'weather_forecasts'];

const FINGERPRINT_LENGTH = 12;

/**
 * A short, stable identifier for a key that cannot be used to authenticate as
 * it. SHA-256 of the value, truncated. Recorded in tickets so a later reader
 * can tell two keys apart without either value entering the record.
 */
export function fingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/** Decodes a JWT payload, or null if the token is not a readable JWT. */
export function readClaims(key) {
  const parts = String(key).split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** The project ref a Supabase URL points at, or null if it is not a project URL. */
export function refFromUrl(url) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in)\/?$/i.exec(String(url).trim());
  return match ? match[1] : null;
}

/**
 * Validates the build variables without touching the network.
 *
 * Pure and total: it returns a report rather than throwing, so the CLI, the
 * tests and any future caller all see the same findings the same way.
 *
 * `now` is injected rather than read from the clock so the expiry check is
 * testable and not dead code. An expiry check written against the real clock
 * cannot be exercised without waiting years, so it is usually never exercised.
 */
export function validateBuildEnv({ url, anonKey }, { now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];

  if (isBlank(url)) {
    errors.push('VITE_SUPABASE_URL is not set.');
  } else if (!/^https:\/\//i.test(url.trim())) {
    errors.push('VITE_SUPABASE_URL is not an https:// URL.');
  } else if (!refFromUrl(url)) {
    warnings.push(
      'VITE_SUPABASE_URL is not a <ref>.supabase.co host, so the project ref ' +
        'cannot be cross-checked against the key.',
    );
  }

  if (isBlank(anonKey)) {
    errors.push('VITE_SUPABASE_ANON_KEY is not set.');
    return { ok: false, errors, warnings, fingerprint: null, claims: null, urlRef: refFromUrl(url) };
  }

  const key = anonKey.trim();
  const claims = readClaims(key);

  if (!claims) {
    errors.push(
      'VITE_SUPABASE_ANON_KEY is not a JWT. The anon key Supabase issues is a ' +
        'JWT, so a non-JWT here is the wrong kind of value entirely.',
    );
  } else {
    if (claims.role !== 'anon') {
      errors.push(
        `VITE_SUPABASE_ANON_KEY has role "${claims.role ?? 'none'}", expected "anon". ` +
          'A service_role key inlined into a browser bundle hands every reader ' +
          'full write access. Rotate it and refuse the build.',
      );
    }
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= now) {
      errors.push(
        `VITE_SUPABASE_ANON_KEY expired at ${new Date(claims.exp * 1000).toISOString()}. ` +
          'Every read will 401 and the build will still be green.',
      );
    }
  }

  // The mis-pairing from BEL-82: a key that is valid and unexpired, issued for
  // a project other than the one the app is pointed at. Nothing about either
  // value looks wrong on its own, which is why it survived a build.
  const urlRef = refFromUrl(url);
  if (claims?.ref && urlRef && claims.ref !== urlRef) {
    errors.push(
      `VITE_SUPABASE_ANON_KEY is issued for project "${claims.ref}" but ` +
        `VITE_SUPABASE_URL points at "${urlRef}". This is a host/key mis-pairing ` +
        '(BEL-82): both values are individually well formed and every read 401s.',
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fingerprint: fingerprint(key),
    claims,
    urlRef,
  };
}

/**
 * Asks Supabase to read with this key, the way a reader's browser will.
 *
 * This is the check that a shape validator cannot make. A key can be a
 * well-formed, unexpired, `anon` JWT naming the right project and still be
 * refused, because the project decided to stop accepting it. Only a real read
 * distinguishes those, and only a real read is what a reader experiences.
 *
 * `fetchImpl` and `sleep` are injected so the retry path is testable. A retry
 * loop whose clock is the real clock cannot be tested without waiting for it.
 */
export async function probeProject(
  { url, anonKey },
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tables = REQUIRED_TABLES,
    attempts = 3,
    backoffMs = 250,
    now = Date.now,
  } = {},
) {
  const report = validateBuildEnv({ url, anonKey }, { now: now() });
  if (!report.ok) {
    return { ...report, results: [], probed: false };
  }

  const ref = report.urlRef;
  if (!ref) {
    return {
      ...report,
      ok: false,
      probed: false,
      errors: [
        ...report.errors,
        'Cannot probe: VITE_SUPABASE_URL is not a project host, so there is no ' +
          'REST endpoint to read.',
      ],
      results: [],
    };
  }

  const key = anonKey.trim();
  const results = [];

  for (const table of tables) {
    let lastStatus = null;
    let lastBody = '';
    let ok = false;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`https://${ref}.supabase.co/rest/v1/${table}?select=*`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
      } catch (error) {
        // A transport failure is retried: the host may be briefly unreachable,
        // and reporting that as a bad key would be a misdiagnosis.
        lastStatus = 'network';
        lastBody = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(backoffMs * attempt);
        continue;
      }

      lastStatus = response.status;
      lastBody = (await response.text()).slice(0, 200);
      ok = response.status >= 200 && response.status < 300;

      // A read that worked is an answer. Without this break the loop runs to
      // `attempts` regardless, so a healthy key is asked the same question
      // three times per table on every deploy -- which is both wasted requests
      // against the live project and a chance to be reported a later failure.
      if (ok) break;

      // 4xx other than 429 is a verdict, not a blip. Retrying a rejected key
      // only delays the same answer and risks the appearance of flakiness.
      if (response.status < 500 && response.status !== 429) break;
      if (attempt < attempts) await sleep(backoffMs * attempt);
    }

    results.push({ table, ok, status: lastStatus, body: lastBody });
  }

  const failed = results.filter((result) => !result.ok);
  return {
    ...report,
    ok: report.ok && failed.length === 0,
    probed: true,
    results,
    errors: [
      ...report.errors,
      ...failed.map(
        (result) =>
          `Supabase refused a read of "${result.table}" with this key: ` +
          `status ${result.status}${result.body ? `, ${summariseBody(result.body)}` : ''}. ` +
          'The key is well formed and names the right project, so the project is ' +
          'not accepting it. Someone with authority over the Supabase project has ' +
          'to say whether it was revoked or superseded.',
      ),
    ],
  };
}

/** Trims a Supabase error body down to something loggable. */
function summariseBody(body) {
  return body.replace(/\s+/g, ' ').trim();
}

export function formatReport({ ok, errors, warnings, fingerprint: fp, claims, urlRef, results, probed }) {
  const lines = [];

  lines.push('BEL-308 build-env gate');
  lines.push(`  VITE_SUPABASE_URL project  ${urlRef ?? 'unrecognised'}`);
  if (fp) {
    lines.push(`  anon key fingerprint        sha256[:${FINGERPRINT_LENGTH}] = ${fp}`);
    lines.push(`  anon key role / ref         ${claims?.role ?? 'unreadable'} / ${claims?.ref ?? 'unreadable'}`);
    lines.push(
      `  anon key expires            ${
        typeof claims?.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : 'unreadable'
      }`,
    );
  } else {
    lines.push('  anon key fingerprint        none (not set)');
  }

  if (probed) {
    for (const result of results) {
      lines.push(`  probe ${result.table.padEnd(20)} ${result.ok ? 'ok' : `FAILED status ${result.status}`}`);
    }
  } else {
    lines.push('  probe                       skipped (no network in this mode)');
  }

  for (const warning of warnings ?? []) lines.push(`  warning: ${warning}`);
  for (const error of errors ?? []) lines.push(`  error: ${error}`);

  lines.push('');
  lines.push(ok ? '  RESULT: pass' : '  RESULT: fail -- this build must not publish an artifact');
  return lines.join('\n');
}

/** True when this module is the process entrypoint, not an import. */
function isEntrypoint() {
  const invoked = process.argv[1] ?? '';
  return invoked.endsWith('build-env.mjs') || invoked.endsWith('build-env.js');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const probe = argv.includes('--probe');
  const help = argv.includes('--help') || argv.includes('-h');

  if (help) {
    process.stdout.write(
      [
        'Usage: node scripts/build-env.mjs [--probe]',
        '',
        '  (no flag)  Validate that the Supabase build variables are present,',
        '             well formed, unexpired, `anon`, and issued for the project',
        '             the URL points at. No network.',
        '  --probe    Additionally read from the project with this key and',
        '             require a 200 on every required table. Needs network.',
        '',
        'Exits 0 to pass, 1 to fail. Never prints a key value.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const inputs = { url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY };
  const report = probe ? await probeProject(inputs) : validateBuildEnv(inputs);

  process.stdout.write(`${formatReport(report)}\n`);
  return report.ok ? 0 : 1;
}

if (isEntrypoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`build-env gate could not run: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}