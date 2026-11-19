import { describe, expect, it } from 'vitest';
import { runCli, type Io } from '../src/index.js';

const denied = () => new Response(JSON.stringify({ error: { code: 'program_scoped_key', message: 'limited to some programs' } }), { status: 403 });
const program = { id: 'prg_1', name: 'Pro', status: 'active', trackingConsent: null, effectiveTrackingConsent: 'auto', trackingToken: 'tok_1' };

function routes(context: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'GET /v1/me': { apiKey: { name: 'snap', scopes: ['programs:read'], livemode: true, expiresAt: null, programIds: ['prg_1'] } },
    'GET /v1/programs/prg_1': program,
    'GET /v1/programs/prg_1/terms': { base: { kind: 'percent', bps: 2000 } },
    'GET /v1/programs/prg_1/doctor-context': context,
    'GET /v1/webhook-endpoints': [],
    'GET /v1/billing/connections': [{ id: 'bcon_1', provider: 'generic', name: 'Snap', status: 'active', programIds: ['prg_1'] }],
    'GET /v1/auth/connections': [],
    'GET /v1/org': denied(),
    'GET /v1/org/tracking-consent': denied(),
    'GET /v1/payout-connections': denied(),
    'GET /v1/email/settings': denied(),
    'GET /v1/integration-health': {
      ok: false,
      checks: [{ id: 'billing.customer_ref_namespace.bcon_1', ok: false, severity: 'error', detail: 'None of 1 recent billing customerRef(s) matches a referral', fix: 'Put the Atlas user id in the metadata' }],
    },
    'GET /t/tok_1/config.json': { cookieWindowDays: 60 },
    'GET /v1/commissions': [],
    ...over,
  };
}

async function run(r: Record<string, unknown>) {
  const fetchFn = (async (url: string, init: RequestInit) => {
    const hit = r[`${init.method} ${new URL(url).pathname}`];
    if (hit instanceof Response) return hit.clone();
    if (hit === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200 });
  }) as typeof fetch;
  const out: string[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => out.push(l),
    env: { REFERALLI_API_KEY: 'rk_live_1', REFERALLI_API_URL: 'http://api.test' },
    fetchFn,
    sleep: async () => {},
    openBrowser: () => false,
    signal: new AbortController().signal,
  };
  const code = await runCli(['doctor'], io);
  return { code, out: out.join('\n') };
}

describe('doctor with a program-scoped key (doctor-context)', () => {
  const ctx = (email: Record<string, unknown>, connections: unknown[] = []) => ({
    programId: 'prg_1',
    tracking: { trackingToken: 'tok_1', scriptPath: '/t/tok_1/aff.js', consent: 'auto' },
    payouts: { settlement: 'payout', connections },
    email,
  });

  it('skips nothing: payouts and the sender come from the context', async () => {
    const { out } = await run(
      routes(ctx({ source: 'org', provider: 'resend', fromAddress: 'hi@snap.example', domainStatus: 'verified', sends: true }, [{ provider: 'stripe', env: 'live', status: 'active' }])),
    );
    expect(out).toContain('✓ payouts.connection: payout connection: stripe');
    expect(out).toContain('✓ email.sender.prg_1: "Pro" mails from hi@snap.example through resend (the org\'s provider)');
    expect(out).not.toContain('payouts: skipped');
    expect(out).not.toContain('email: skipped');
  });

  it('warns on the shared sender and says no email is sent with no provider', async () => {
    const shared = await run(routes(ctx({ source: 'platform', provider: null, fromAddress: 'partners@referalli.com', domainStatus: null, sends: true })));
    expect(shared.out).toContain('⚠ email.sender.prg_1: "Pro" has no bring-your-own sender: it mails from the shared Referalli sender partners@referalli.com');
    const none = await run(routes(ctx({ source: 'none', provider: null, fromAddress: null, domainStatus: null, sends: false })));
    expect(none.out).toContain('no email provider is configured for "Pro": no email is sent');
  });

  it('a customerRef namespace error fails the run even for a program key', async () => {
    const { code, out } = await run(routes(ctx({ source: 'none', provider: null, fromAddress: null, domainStatus: null, sends: false })));
    expect(out).toContain('✗ health.billing.customer_ref_namespace.bcon_1');
    expect(code).toBe(1);
  });

  it('an org key flags an unscoped billing connection when the org has several programs', async () => {
    const { out } = await run(
      routes(ctx({ source: 'org', provider: 'resend', fromAddress: 'a@b.c', domainStatus: 'verified', sends: true }), {
        'GET /v1/me': { apiKey: { name: 'org', scopes: ['full'], livemode: true, expiresAt: null, programIds: null } },
        'GET /v1/programs': { object: 'list', data: [program, { ...program, id: 'prg_2', name: 'Two' }], has_more: false },
        'GET /v1/programs/prg_2': { ...program, id: 'prg_2', name: 'Two' },
        'GET /v1/programs/prg_2/terms': { base: { kind: 'percent', bps: 1000 } },
        'GET /v1/programs/prg_2/doctor-context': { ...ctx({ source: 'org', provider: 'resend', fromAddress: 'a@b.c', domainStatus: 'verified', sends: true }), programId: 'prg_2' },
        'GET /v1/billing/connections': [{ id: 'bcon_1', provider: 'generic', name: 'Snap', status: 'active', programIds: null }],
        'GET /v1/org': { id: 'org_1', trackingToken: 'tok_1' },
        'GET /v1/org/tracking-consent': { mode: 'auto' },
        'GET /v1/payout-connections': [],
        'GET /v1/email/settings': { provider: 'resend', hasApiKey: true },
        'GET /v1/integration-health': { ok: true, checks: [] },
      }),
    );
    expect(out).toContain('⚠ billing.scope.bcon_1: billing connection "Snap" has no programIds');
  });
});
