import { describe, expect, it } from 'vitest';
import { runCli, type Io } from '../src/index.js';

type Routes = Record<string, unknown>;

/** A healthy account; override any "METHOD /path" with a body or a Response. */
function healthy(over: Routes = {}): Routes {
  return {
    'GET /v1/me': { apiKey: { name: 'ci', scopes: ['full'], livemode: false, expiresAt: null, programIds: null } },
    'GET /v1/programs': { object: 'list', data: [{ id: 'prg_1', name: 'Pro', status: 'active' }, { id: 'prg_2', name: 'Old', status: 'archived' }], has_more: false },
    'GET /v1/programs/prg_1/terms': { base: { kind: 'percent', bps: 2000 } },
    'GET /v1/webhook-endpoints': [{ id: 'we_1', url: 'https://x.test/h', status: 'active', health: 'healthy', consecutiveFailures: 0, lastFailure: null }],
    'GET /v1/billing/connections': [{ id: 'bcon_1', provider: 'stripe', name: 'Stripe', status: 'active' }],
    'GET /v1/auth/connections': [{ id: 'acon_1', provider: 'clerk', name: null, status: 'active', tokenVerification: null, allowedOrigins: [] }],
    'GET /v1/org': { id: 'org_1', trackingToken: 'tok_1' },
    'GET /t/tok_1/config.json': { cookieWindowDays: 60 },
    'GET /v1/org/tracking-consent': { mode: 'auto' },
    ...over,
  };
}

function run(routes: Routes, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const fetchFn = (async (url: string, init: RequestInit) => {
    const r = routes[`${init.method} ${new URL(url).pathname}`];
    if (r instanceof Response) return r;
    if (r === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  const out: string[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => out.push(l),
    env: { REFERALLI_API_KEY: 'rk_test_1', REFERALLI_API_URL: 'http://api.test', ...extraEnv },
    fetchFn,
    sleep: async () => {},
    openBrowser: () => false,
    signal: new AbortController().signal,
  };
  return runCli(['doctor', ...args], io).then((code) => ({ code, out: out.join('\n') }));
}

const err = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status });

describe('referalli doctor', () => {
  it('all good: every check ✓ and exit 0; archived programs are skipped', async () => {
    const { code, out } = await run(healthy());
    expect(code).toBe(0);
    expect(out).not.toMatch(/[⚠✗]/);
    expect(out).toContain('✓ program.prg_1.terms');
    expect(out).not.toContain('prg_2');
    expect(out).toContain('cookie window 60 days');
  });

  it('an awaiting_secret billing connection fails with the PUT …/secret fix, exit 1', async () => {
    const { code, out } = await run(healthy({ 'GET /v1/billing/connections': [{ id: 'bcon_1', provider: 'paddle', name: 'P', status: 'awaiting_secret' }] }));
    expect(code).toBe(1);
    expect(out).toContain('✗ billing.bcon_1: paddle connection "P": provider secret not set');
    expect(out).toContain('fix: PUT /v1/billing/connections/bcon_1/secret');
  });

  it('--json prints { checks } with statuses; warnings alone exit 0', async () => {
    const { code, out } = await run(
      healthy({
        'GET /v1/me': { apiKey: { name: 'ci', scopes: ['programs:read'], livemode: true, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), programIds: ['prg_1'] } },
        'GET /v1/programs/prg_1': { id: 'prg_1', name: 'Pro', status: 'active' },
        'GET /v1/programs/prg_1/terms': err(404, 'not_found', 'this program has no commission rule yet'),
        'GET /v1/billing/connections': [],
        'GET /v1/auth/connections': [{ id: 'acon_1', provider: 'atlas', name: 'A', status: 'active', tokenVerification: { preset: 'atlas' }, allowedOrigins: [] }],
        'GET /v1/webhook-endpoints': [{ id: 'we_1', url: 'https://x.test/h', status: 'active', health: 'failing', consecutiveFailures: 4, lastFailure: { statusCode: 500, error: null } }],
      }),
      ['--json', '--program', 'prg_1'],
    );
    expect(code).toBe(1); // the missing rule
    const { checks } = JSON.parse(out) as { checks: Array<{ id: string; status: string; message: string; fix?: string }> };
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.key!.status).toBe('ok');
    expect(by['key.expiry']!.status).toBe('warn');
    expect(by['key.programs']!.status).toBe('warn');
    expect(by['program.prg_1.terms']).toMatchObject({ status: 'fail', message: expect.stringContaining('no commission rule') });
    expect(by.billing).toMatchObject({ status: 'warn', message: expect.stringContaining('no billing connection') });
    expect(by['auth.acon_1']!.status).toBe('warn');
    expect(by['webhook.we_1']).toMatchObject({ status: 'warn', fix: 'GET /v1/webhook-endpoints/we_1/deliveries' });
    for (const c of checks) expect(['ok', 'warn', 'fail']).toContain(c.status);
  });

  it('a 403 on one endpoint becomes a warning and the other checks still run', async () => {
    const { code, out } = await run(healthy({ 'GET /v1/billing/connections': err(403, 'forbidden', 'needs billing:read') }));
    expect(code).toBe(0);
    expect(out).toContain("⚠ billing: couldn't check: 403 forbidden: needs billing:read");
    expect(out).toContain('✓ tracking');
  });

  describe('Atlas adapter and the configured tracking token', () => {
    const atlas = (lastSignupAt: string | null) => ({
      'GET /v1/auth/connections': [{ id: 'acon_a', provider: 'atlas', name: 'Atlas', status: 'active', tokenVerification: null, allowedOrigins: [], lastSignupAt }],
    });
    const tokens = { 'GET /v1/org/tracking-tokens': { mode: 'live', live: { trackingToken: 'tok_1' }, test: { trackingToken: 'tok_t' } } };

    it('an active Atlas connection shows its last sign-up', async () => {
      const recent = new Date(Date.now() - 3_600_000).toISOString();
      const { code, out } = await run(healthy(atlas(recent)));
      expect(code).toBe(0);
      expect(out).toContain(`✓ auth.acon_a: atlas auth connection "Atlas" is active; last sign-up ${recent}`);
      expect(out).not.toContain('auth.atlas');
    });

    it('never filed a sign-up, or none in 30 days: a warning', async () => {
      expect((await run(healthy(atlas(null)))).out).toContain('⚠ auth.acon_a: atlas auth connection "Atlas" is active but has never filed a sign-up');
      const { code, out } = await run(healthy(atlas('2020-01-01T00:00:00.000Z')));
      expect(code).toBe(0);
      expect(out).toContain('⚠ auth.acon_a: atlas auth connection "Atlas" is active; no sign-up since 2020-01-01');
    });

    it('no Atlas connection warns only when nothing else files sign-ups; never fails', async () => {
      expect((await run(healthy())).out).toContain('✓ auth.atlas: no Atlas connection; sign-ups come through clerk');
      const { code, out } = await run(healthy({ 'GET /v1/auth/connections': [] }));
      expect(code).toBe(0);
      expect(out).toContain('⚠ auth.atlas: no Atlas connection');
    });

    it("REFERALLI_TRACKING_TOKEN: this mode's token ok, the other mode's warns, anything else fails", async () => {
      expect((await run(healthy(tokens), [], { REFERALLI_TRACKING_TOKEN: 'tok_1' })).out).toContain("✓ tracking.configured: REFERALLI_TRACKING_TOKEN is the org's live token");
      const other = await run(healthy(tokens), [], { NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN: 'tok_t' });
      expect(other.code).toBe(0);
      expect(other.out).toContain("⚠ tracking.configured: NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN is the org's test token but this key is live");
      const wrong = await run(healthy(tokens), [], { REFERALLI_TRACKING_TOKEN: 'tok_nope' });
      expect(wrong.code).toBe(1);
      expect(wrong.out).toContain('✗ tracking.configured: REFERALLI_TRACKING_TOKEN=tok_nope is neither');
      expect(wrong.out).toContain('fix: referalli env pull --mode live');
    });

    it('no configured token: no tracking.configured line', async () => {
      expect((await run(healthy())).out).not.toContain('tracking.configured');
    });
  });

  it("warns on tracking consent 'none' for a live org (FormFlow 2026-11-04 #4)", async () => {
    const { code, out } = await run(healthy({ 'GET /v1/org/tracking-consent': { mode: 'none' } }));
    expect(code).toBe(0);
    expect(out).toContain("⚠ tracking.consent: tracking consent is 'none'");
    expect(out).toContain('fix: PUT /v1/org/tracking-consent {"mode":"auto"}');
    expect((await run(healthy())).out).toContain('✓ tracking.consent: tracking consent: auto');
  });

  it('fails a connection whose last refusal is newer than its last sign-up (FormFlow 2026-11-04 #1)', async () => {
    const conn = (lastError: unknown, lastSignupAt: string | null) => ({
      'GET /v1/auth/connections': [{ id: 'acon_a', provider: 'atlas', name: 'Atlas', status: 'active', tokenVerification: null, allowedOrigins: [], lastSignupAt, lastError }],
    });
    const failing = await run(healthy(conn({ at: '2026-11-04T10:00:00Z', code: 'validation_error', message: 'unknown field(s): atlasUserId' }, null)));
    expect(failing.code).toBe(1);
    expect(failing.out).toContain('✗ auth.acon_a: atlas auth connection "Atlas" refused its last call (2026-11-04T10:00:00Z): validation_error: unknown field(s): atlasUserId');
    const recovered = await run(healthy(conn({ at: '2026-11-04T10:00:00Z', code: 'validation_error', message: 'x' }, new Date().toISOString())));
    expect(recovered.out).not.toContain('refused its last call');
  });
});
