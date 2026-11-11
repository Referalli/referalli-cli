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
    'GET /v1/programs/prg_1': { id: 'prg_1', name: 'Pro', status: 'active' },
    'GET /v1/integration-health': { ok: true, checks: [{ id: 'billing.bcon_1', ok: true, detail: 'Last event received 2026-11-10T00:00:00.000Z.' }] },
    'GET /v1/commissions': [],
    ...over,
  };
}

function run(routes: Routes, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const fetchFn = (async (url: string, init: RequestInit) => {
    const r = routes[`${init.method} ${new URL(url).pathname}`];
    if (typeof r === 'function') return (r as (u: URL) => Response)(new URL(url)); // answers by query
    if (r instanceof Response) return r.clone();
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
  const e2e = (over: Routes = {}) =>
    healthy({
      'GET /v1/programs/prg_1': { id: 'prg_1', name: 'Pro', status: 'active' },
      'GET /v1/org': { id: 'org_1', trackingToken: 'tok_1', livemode: false },
      'GET /t/tok_1/aff.js': new Response('//js'),
      'GET /v1/links': [{ code: 'abc', destinationUrl: 'http://shop.test/' }],
      'GET /': new Response('<script src="https://referalli.com/t/tok_1/aff.js"></script>'),
      'GET /go/tok_1/abc': new Response(null, { status: 302, headers: { location: 'http://shop.test/?via=abc' } }),
      'POST /v1/sandbox/simulate': { ok: true },
      ...over,
    });
  const byId = (out: string) => Object.fromEntries((JSON.parse(out) as { checks: Array<{ id: string; status: string }> }).checks.map((c) => [c.id, c.status]));

  it('--e2e walks one program from outside and files a test conversion with a test key', async () => {
    const { out } = await run(e2e(), ['--json', '--program', 'prg_1', '--e2e']);
    expect(byId(out)).toMatchObject({ 'e2e.script': 'ok', 'e2e.destination': 'ok', 'e2e.landing': 'ok', 'e2e.go': 'ok', 'e2e.cookie': 'warn', 'e2e.conversion': 'ok' });
  });

  it('--e2e fails on a dead destination, and a live key never files a conversion', async () => {
    const routes = e2e({
      'GET /v1/me': { apiKey: { name: 'ci', scopes: ['full'], livemode: true, expiresAt: null, programIds: null } },
      'GET /': new Response('gone', { status: 404 }),
    });
    const { code, out } = await run(routes, ['--json', '--program', 'prg_1', '--e2e']);
    expect(code).toBe(1);
    expect(byId(out)).toMatchObject({ 'e2e.destination': 'fail', 'e2e.conversion': 'warn' });
  });

  it('--e2e runs with a program-scoped key, taking the token from the env', async () => {
    const refused = () => err(403, 'program_scoped_key', 'this key is limited to some programs');
    const scoped = () => e2e({ 'GET /v1/org': refused(), 'GET /v1/auth/connections': refused() });
    const withToken = await run(scoped(), ['--json', '--program', 'prg_1', '--e2e'], { REFERALLI_TRACKING_TOKEN: 'tok_1' });
    expect(byId(withToken.out)).toMatchObject({ 'e2e.script': 'ok', 'e2e.destination': 'ok', 'e2e.go': 'ok' });
    const without = await run(scoped(), ['--json', '--program', 'prg_1', '--e2e']);
    expect(byId(without.out)).toMatchObject({ e2e: 'warn' });
  });

  it('--e2e needs --program', async () => {
    expect((await run(healthy(), ['--e2e'])).out).toContain('--program');
  });

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
    expect(by['key.programs']!.status).toBe('ok'); // R-08: a scoped key is normal; the checks cover its programs
    expect(by['program.prg_1.terms']).toMatchObject({ status: 'fail', message: expect.stringContaining('no commission rule') });
    expect(by.billing).toMatchObject({ status: 'warn', message: expect.stringContaining('no billing connection') });
    expect(by['auth.acon_1']!.status).toBe('warn');
    expect(by['webhook.we_1']).toMatchObject({ status: 'warn', fix: 'GET /v1/webhook-endpoints/we_1/deliveries' });
    for (const c of checks) expect(['ok', 'warn', 'fail']).toContain(c.status);
  });

  it('a program-scoped key: names the checks it skipped and the scope that would run them', async () => {
    const denied = () => err(403, 'program_scoped_key', "this API key is limited to some programs and can't call it; use an org-wide key");
    const { code, out } = await run(
      healthy({
        'GET /v1/me': { apiKey: { name: 'ci', scopes: ['read'], livemode: false, expiresAt: null, programIds: ['prg_1'] } },
        'GET /v1/auth/connections': denied(),
        'GET /v1/org': denied(),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("⚠ auth: skipped, this program-scoped key can't read it");
    expect(out).toContain('with integrations:read or connections:read');
    expect(out).toContain("⚠ tracking: skipped, this program-scoped key can't read it");
    expect(out).toContain('with org:read');
    expect(out).toContain('✓ webhook.we_1');
    expect(out).not.toContain("couldn't check");
  });

  it('a program-scoped key that also lacks the scope gets the same explanation (the API checks scope first)', async () => {
    const { out } = await run(
      healthy({
        'GET /v1/me': { apiKey: { name: 'ci', scopes: ['programs:read'], livemode: false, expiresAt: null, programIds: ['prg_1'] } },
        'GET /v1/auth/connections': err(403, 'forbidden', 'this API key lacks the integrations:read scope'),
      }),
    );
    expect(out).toContain('⚠ auth: skipped');
  });

  it('a 403 for an org-wide key stays a plain "couldn\'t check"', async () => {
    const { out } = await run(healthy({ 'GET /v1/auth/connections': err(403, 'forbidden', 'needs integrations:read') }));
    expect(out).toContain("⚠ auth: couldn't check: 403 forbidden");
    expect(out).not.toContain('skipped');
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

  describe('FormFlow 2026-11-11: scope, integration health and the new checks', () => {
    const live = { 'GET /v1/me': { apiKey: { name: 'ci', scopes: ['full'], livemode: true, expiresAt: null, programIds: null } } };
    const statuses = (out: string) => Object.fromEntries((JSON.parse(out) as { checks: Array<{ id: string; status: string }> }).checks.map((c) => [c.id, c.status]));

    it("R-08: REFERALLI_PROGRAM_ID scopes doctor; another program's broken connections don't fail it", async () => {
      const routes = healthy({
        'GET /v1/billing/connections': [
          { id: 'bcon_1', provider: 'stripe', name: 'Stripe', status: 'active', programIds: ['prg_1'] },
          { id: 'bcon_2', provider: 'paddle', name: 'Other', status: 'awaiting_secret', programIds: ['prg_2'] },
        ],
        'GET /v1/auth/connections': [
          { id: 'acon_1', provider: 'clerk', programId: 'prg_1', name: null, status: 'active', tokenVerification: null, allowedOrigins: [] },
          { id: 'acon_2', provider: 'custom', programId: 'prg_2', name: null, status: 'active', tokenVerification: null, allowedOrigins: [], lastSignupAt: null, lastError: { at: '2026-11-01T00:00:00Z', code: 'x', message: 'y' } },
        ],
      });
      const all = await run(routes);
      expect(all.code).toBe(1);
      const scoped = await run(routes, [], { REFERALLI_PROGRAM_ID: 'prg_1' });
      expect(scoped.code).toBe(0);
      expect(scoped.out).not.toContain('bcon_2');
      expect(scoped.out).not.toContain('acon_2');
      // The key's own scope does the same.
      const byKey = await run({ ...routes, 'GET /v1/me': { apiKey: { name: 'ci', scopes: ['full'], livemode: false, expiresAt: null, programIds: ['prg_1'] } } });
      expect(byKey.code).toBe(0);
      expect(byKey.out).toContain('✓ key.programs');
    });

    it('R-12: every integration-health check shows up, ✗ only for severity error', async () => {
      const { code, out } = await run(
        healthy({
          'GET /v1/integration-health': {
            ok: false,
            checks: [
              { id: 'billing.bcon_1', ok: false, detail: 'generic connection has never received an event.', fix: 'Send a test event.' },
              { id: 'payouts.connection', ok: false, detail: 'No payout connection.', severity: 'error' },
              { id: 'tracking.snippet', ok: true, detail: 'aff.js reported a visit.' },
            ],
          },
        }),
        ['--json'],
      );
      expect(code).toBe(1);
      expect(statuses(out)).toMatchObject({ 'health.billing.bcon_1': 'warn', 'health.payouts.connection': 'fail', 'health.tracking.snippet': 'ok' });
    });

    it('R-12: payout connection, email provider, Atlas widget, unpaid commissions and the join page', async () => {
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const program = { id: 'prg_1', name: 'Pro', status: 'active', publicHandle: 'pro', publicPage: { autoApprove: false }, settings: { settlement: 'payout', widget: { autoEnroll: false, destinationUrl: null } } };
      const routes = healthy({
        ...live,
        'GET /v1/programs': [program],
        'GET /v1/payout-connections': [],
        'GET /v1/email/settings': { provider: null, hasApiKey: false },
        'GET /v1/auth/connections': [{ id: 'acon_a', provider: 'atlas', programId: 'prg_1', name: 'Atlas', status: 'active', tokenVerification: null, allowedOrigins: [], lastSignupAt: new Date().toISOString() }],
        'GET /v1/commissions': (u: URL) => new Response(JSON.stringify(u.searchParams.get('type') === 'approved' ? [{ id: 'cev_1', type: 'approved', relatedCommissionId: 'cev_0', ts: old }] : [])),
        'GET /v1/public/programs/pro': { name: 'Pro' },
        'GET /join/pro': new Response('gone', { status: 404 }),
      });
      const { code, out } = await run(routes, ['--json']);
      expect(code).toBe(1); // the join page
      expect(statuses(out)).toMatchObject({
        'payouts.connection': 'warn',
        'email.provider': 'warn',
        'widget.prg_1': 'warn',
        'commissions.prg_1.unpaid': 'warn',
        'join.prg_1': 'fail',
      });
      const fixed = await run({
        ...routes,
        'GET /v1/payout-connections': [{ provider: 'stripe', status: 'active' }],
        'GET /v1/email/settings': { provider: 'resend', hasApiKey: true },
        'GET /v1/programs': [{ ...program, settings: { settlement: 'payout', widget: { autoEnroll: true, destinationUrl: 'https://x.test' } } }],
        'GET /join/pro': new Response('<html>'),
      }, ['--json']);
      expect(statuses(fixed.out)).toMatchObject({ 'payouts.connection': 'ok', 'email.provider': 'ok', 'join.prg_1': 'ok' });
      expect(statuses(fixed.out)['widget.prg_1']).toBeUndefined();
    });

    it('R-30: staleness reads lastSignupReceivedAt when the API sends it', async () => {
      const { out } = await run(
        healthy({
          'GET /v1/auth/connections': [{ id: 'acon_a', provider: 'atlas', name: 'Atlas', status: 'active', tokenVerification: null, allowedOrigins: [], lastSignupAt: new Date().toISOString(), lastSignupReceivedAt: '2020-01-01T00:00:00.000Z' }],
        }),
      );
      expect(out).toContain('⚠ auth.acon_a: atlas auth connection "Atlas" is active; no sign-up since 2020-01-01T00:00:00.000Z');
    });
  });
});
