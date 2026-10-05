// @vitest-environment node

// BEL-308. Tests for the build-env gate.
//
// The gate is the only thing standing between a green build and a site that
// serves no stories, so the cases that matter are the ones where the build
// would otherwise have succeeded: absent values, wrong values, mis-paired
// values, and values that are individually perfect but that the project no
// longer accepts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REQUIRED_TABLES,
  fingerprint,
  formatReport,
  main,
  probeProject,
  readClaims,
  refFromUrl,
  validateBuildEnv,
} from './build-env.mjs';

/** Builds a JWT-shaped token carrying `claims`, without signing anything. */
function token(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const VALID_CLAIMS = {
  role: 'anon',
  ref: 'hocwwzzawiwkxghvfasg',
  iss: 'supabase',
  exp: 2080000000,
};
const VALID_KEY = token(VALID_CLAIMS);
const VALID_URL = 'https://hocwwzzawiwkxghvfasg.supabase.co';
const NOW = 1_700_000_000_000;

describe('fingerprint', () => {
  it('is stable for the same key', () => {
    expect(fingerprint(VALID_KEY)).toBe(fingerprint(VALID_KEY));
  });

  it('differs for different keys', () => {
    expect(fingerprint(VALID_KEY)).not.toBe(fingerprint(token({ ...VALID_CLAIMS, ref: 'other' })));
  });

  it('is short enough to write in a ticket and does not contain the key', () => {
    expect(fingerprint(VALID_KEY)).toHaveLength(12);
    expect(fingerprint(VALID_KEY)).not.toContain(VALID_KEY.split('.')[1]);
  });
});

describe('readClaims', () => {
  it('reads the payload of a JWT', () => {
    expect(readClaims(VALID_KEY)).toMatchObject({ role: 'anon', ref: 'hocwwzzawiwkxghvfasg' });
  });

  it('returns null for a non-JWT', () => {
    expect(readClaims('placeholder-not-a-real-key')).toBeNull();
  });

  it('returns null for a JWT whose payload is not JSON', () => {
    expect(readClaims('header.bm90LWpzb24.sig')).toBeNull();
  });

  it('returns null for a token with the wrong number of parts', () => {
    expect(readClaims('a.b')).toBeNull();
  });
});

describe('refFromUrl', () => {
  it('extracts the project ref', () => {
    expect(refFromUrl(VALID_URL)).toBe('hocwwzzawiwkxghvfasg');
  });

  it('tolerates a trailing slash', () => {
    expect(refFromUrl(`${VALID_URL}/`)).toBe('hocwwzzawiwkxghvfasg');
  });

  it('returns null for a URL that is not a project host', () => {
    expect(refFromUrl('https://placeholder.invalid')).toBeNull();
    expect(refFromUrl('http://hocwwzzawiwkxghvfasg.supabase.co')).toBeNull();
  });
});

describe('validateBuildEnv', () => {
  it('passes a correct pair', () => {
    const report = validateBuildEnv({ url: VALID_URL, anonKey: VALID_KEY }, { now: NOW });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.fingerprint).toBe(fingerprint(VALID_KEY));
  });

  it('fails when the URL is missing, which `vite build` does not', () => {
    const report = validateBuildEnv({ url: undefined, anonKey: VALID_KEY }, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/VITE_SUPABASE_URL is not set/);
  });

  it('fails when the key is missing', () => {
    const report = validateBuildEnv({ url: VALID_URL, anonKey: '' }, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/VITE_SUPABASE_ANON_KEY is not set/);
  });

  it('treats whitespace as missing', () => {
    const report = validateBuildEnv({ url: '   ', anonKey: '\t\n' }, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(2);
  });

  it('fails on a non-https URL', () => {
    const report = validateBuildEnv({ url: 'ftp://example.com', anonKey: VALID_KEY }, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/not an https/);
  });

  it('fails on a key that is not a JWT, naming the CI placeholder explicitly', () => {
    const report = validateBuildEnv(
      { url: VALID_URL, anonKey: 'placeholder-not-a-real-key' },
      { now: NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/not a JWT/);
  });

  // The build trap from BEL-170: `npm run build` with these values is green.
  it('fails on the CI build placeholders, which today build successfully', () => {
    const report = validateBuildEnv(
      { url: 'https://placeholder.invalid', anonKey: 'placeholder-not-a-real-key' },
      { now: NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('refuses a service_role key, and says why it matters', () => {
    const report = validateBuildEnv(
      { url: VALID_URL, anonKey: token({ ...VALID_CLAIMS, role: 'service_role' }) },
      { now: NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/service_role key inlined into a browser bundle/);
  });

  // An expiry check written against the real clock is never exercised, so it is
  // usually dead code. `now` is injected so this case is reachable.
  it('fails on an expired key', () => {
    const expired = token({ ...VALID_CLAIMS, exp: NOW / 1000 - 60 });
    const report = validateBuildEnv({ url: VALID_URL, anonKey: expired }, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/expired at/);
  });

  it('passes a key that expires far in the future', () => {
    const report = validateBuildEnv({ url: VALID_URL, anonKey: VALID_KEY }, { now: NOW });
    expect(report.ok).toBe(true);
  });

  // BEL-82. Both values are individually valid; together they read nothing.
  it('fails on the BEL-82 mis-pairing: a key issued for another project', () => {
    const report = validateBuildEnv(
      { url: VALID_URL, anonKey: token({ ...VALID_CLAIMS, ref: 'nchzjfznvnfsqnrsrzgt' }) },
      { now: NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/mis-pairing/);
    expect(report.errors.join(' ')).toContain('nchzjfznvnfsqnrsrzgt');
    expect(report.errors.join(' ')).toContain('hocwwzzawiwkxghvfasg');
  });

  it('warns but does not fail when the URL is not a project host', () => {
    const report = validateBuildEnv(
      { url: 'https://proxy.internal', anonKey: token({ ...VALID_CLAIMS, ref: undefined }) },
      { now: NOW },
    );
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/cannot be cross-checked/);
  });

  it('does not report a fingerprint when no key was supplied', () => {
    const report = validateBuildEnv({ url: VALID_URL, anonKey: '' }, { now: NOW });
    expect(report.fingerprint).toBeNull();
  });
});

/** Minimal Response stand-in, so the probe path needs no network. */
function reply(status, body = '') {
  return {
    status,
    headers: new Map([['content-range', '0-6/*']]),
    text: async () => body,
  };
}

describe('probeProject', () => {
  // A fresh mock per test. A mock created once in the describe body carries its
  // call history into every later test, which makes an assertion about call
  // counts depend on test order.
  let okFetch;
  beforeEach(() => {
    okFetch = vi.fn(async () => reply(200, '[]'));
  });

  it('passes when both required tables read 200', async () => {
    const report = await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl: okFetch, now: () => NOW },
    );
    expect(report.ok).toBe(true);
    expect(report.probed).toBe(true);
    expect(report.results.map((r) => r.table)).toEqual(REQUIRED_TABLES);
    expect(report.results.every((r) => r.ok)).toBe(true);
  });

  it('sends the key on both apikey and Authorization, the way the browser does', async () => {
    await probeProject({ url: VALID_URL, anonKey: VALID_KEY }, { fetchImpl: okFetch, now: () => NOW });
    const [, init] = okFetch.mock.calls[0];
    expect(init.headers.apikey).toBe(VALID_KEY);
    expect(init.headers.Authorization).toBe(`Bearer ${VALID_KEY}`);
  });

  it('reads exactly the two tables the app cannot work without', async () => {
    await probeProject({ url: VALID_URL, anonKey: VALID_KEY }, { fetchImpl: okFetch, now: () => NOW });
    const urls = okFetch.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      'https://hocwwzzawiwkxghvfasg.supabase.co/rest/v1/stories?select=*',
      'https://hocwwzzawiwkxghvfasg.supabase.co/rest/v1/weather_forecasts?select=*',
    ]);
  });

  // The shape BEL-308 was filed as. Nothing about the key looks wrong; only a
  // real read distinguishes it from a working key.
  it('fails when a well-formed key for the right project is refused', async () => {
    const fetchImpl = vi.fn(async () => reply(401, '{"message":"Invalid API key"}'));
    const report = await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep: async () => {}, now: () => NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.probed).toBe(true);
    expect(report.errors.join(' ')).toMatch(/refused a read of "stories"/);
    expect(report.errors.join(' ')).toMatch(/Someone with authority over the Supabase project/);
    // A verdict, not a blip: no retries.
    expect(fetchImpl).toHaveBeenCalledTimes(REQUIRED_TABLES.length);
  });

  it('does not retry a 4xx, because the answer will not change', async () => {
    const fetchImpl = vi.fn(async () => reply(403, '{"message":"permission denied"}'));
    const sleep = vi.fn(async () => {});
    await probeProject({ url: VALID_URL, anonKey: VALID_KEY }, { fetchImpl, sleep, now: () => NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(REQUIRED_TABLES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  // A healthy key must be asked once per table. Reading three times because the
  // loop only stopped on the attempt limit is wasted traffic against the live
  // project on every deploy, and it can turn a passing gate red on a later,
  // unrelated failure.
  it('asks a healthy key exactly once per table', async () => {
    const sleep = vi.fn(async () => {});
    await probeProject({ url: VALID_URL, anonKey: VALID_KEY }, { fetchImpl: okFetch, sleep, now: () => NOW });
    expect(okFetch).toHaveBeenCalledTimes(REQUIRED_TABLES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops probing a table as soon as it reads 200', async () => {
    const sleep = vi.fn(async () => {});
    await probeProject({ url: VALID_URL, anonKey: VALID_KEY }, { fetchImpl: okFetch, sleep, attempts: 5, now: () => NOW });
    expect(okFetch).toHaveBeenCalledTimes(REQUIRED_TABLES.length);
  });

  it('retries a 5xx and can still pass', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls <= 2 ? reply(502, 'bad gateway') : reply(200, '[]');
    });
    const sleep = vi.fn(async () => {});
    const report = await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep, now: () => NOW },
    );
    expect(report.ok).toBe(true);
    // Two sleeps, both on the first table: calls 1 and 2 are the 502s, call 3
    // succeeds, and the second table then succeeds first time.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('gives up after the configured attempts and reports the last status', async () => {
    const fetchImpl = vi.fn(async () => reply(503, 'unavailable'));
    const report = await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep: async () => {}, attempts: 2, now: () => NOW },
    );
    expect(report.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2 * REQUIRED_TABLES.length);
    expect(report.errors.join(' ')).toMatch(/status 503/);
  });

  it('retries a transport failure rather than calling it a bad key', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls <= 1) throw new Error('ECONNRESET');
      return reply(200, '[]');
    });
    const report = await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep: async () => {}, now: () => NOW },
    );
    expect(report.ok).toBe(true);
  });

  it('reports a persistent transport failure without blaming the key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const report = await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep: async () => {}, attempts: 2, now: () => NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/status network/);
  });

  it('backs off by attempt, so the delay grows', async () => {
    const fetchImpl = vi.fn(async () => reply(500, 'boom'));
    const sleep = vi.fn(async () => {});
    await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep, attempts: 3, backoffMs: 100, now: () => NOW },
    );
    // Per table, so the pattern repeats once for each.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 100, 200]);
  });

  // `attempts` bounds the retries, so the number of requests is a function of
  // the configuration and not of how long the project is unhealthy.
  it('never asks a table more times than `attempts`', async () => {
    const fetchImpl = vi.fn(async () => reply(500, 'boom'));
    await probeProject(
      { url: VALID_URL, anonKey: VALID_KEY },
      { fetchImpl, sleep: async () => {}, attempts: 4, now: () => NOW },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4 * REQUIRED_TABLES.length);
  });

  it('never probes a mis-paired key, so it cannot report a misleading 401', async () => {
    const fetchImpl = vi.fn(async () => reply(200, '[]'));
    const report = await probeProject(
      { url: VALID_URL, anonKey: token({ ...VALID_CLAIMS, ref: 'nchzjfznvnfsqnrsrzgt' }) },
      { fetchImpl, now: () => NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.probed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never probes when a variable is missing', async () => {
    const fetchImpl = vi.fn(async () => reply(200, '[]'));
    const report = await probeProject({ url: VALID_URL }, { fetchImpl, now: () => NOW });
    expect(report.probed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to probe a URL that is not a project host', async () => {
    const fetchImpl = vi.fn(async () => reply(200, '[]'));
    const report = await probeProject(
      { url: 'https://proxy.internal', anonKey: token({ ...VALID_CLAIMS, ref: undefined }) },
      { fetchImpl, now: () => NOW },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/not a project host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('reporting', () => {
  // Rule 4: a credential never reaches a log, a ticket, or a chat.
  it('never prints the key value, on either path', () => {
    const okText = formatReport(validateBuildEnv({ url: VALID_URL, anonKey: VALID_KEY }, { now: NOW }));
    const failText = formatReport(validateBuildEnv({ url: VALID_URL, anonKey: 'placeholder' }, { now: NOW }));

    expect(okText).not.toContain(VALID_KEY);
    expect(okText).not.toContain(VALID_KEY.split('.')[1]);
    expect(failText).not.toContain('placeholder');
    expect(okText).toContain(fingerprint(VALID_KEY));
  });

  it('says RESULT fail in words a workflow can grep', () => {
    const text = formatReport(validateBuildEnv({ url: VALID_URL, anonKey: '' }, { now: NOW }));
    expect(text).toContain('RESULT: fail');
  });

  it('says when the probe was skipped, so a pass is never mistaken for a probe', () => {
    const text = formatReport(validateBuildEnv({ url: VALID_URL, anonKey: VALID_KEY }, { now: NOW }));
    expect(text).toContain('probe                       skipped');
  });
});

describe('main', () => {
  // `main` writes its report to stdout. Without this the suite's own output is
  // interleaved with a dozen gate reports, and a real failure is hard to find.
  let write;
  beforeEach(() => {
    write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    write.mockRestore();
  });

  it('exits 0 on a correct pair and 1 on a wrong one', async () => {
    const good = await main([], { VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: VALID_KEY });
    const bad = await main([], { VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: 'nope' });
    expect(good).toBe(0);
    expect(bad).toBe(1);
  });

  it('does not touch the network without --probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await main([], { VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: VALID_KEY });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('prints help and exits 0', async () => {
    const code = await main(['--help'], {});
    expect(code).toBe(0);
    expect(write.mock.calls.join('')).toMatch(/--probe/);
  });
});