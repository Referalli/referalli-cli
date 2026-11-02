import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type Io } from '../src/index.js';

/** An in-memory account behind the /v1 routes `plan`/`apply` use; records every call. */
function fakeAccount() {
  type Row = Record<string, unknown> & { id: string };
  const db = { programs: [] as Row[], rules: [] as Row[], credits: new Map<string, Row>(), hooks: [] as Row[], keys: [] as Row[] };
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined; headers: Record<string, string> }> = [];
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const method = String(init.method);
    calls.push({ method, path: u.pathname + u.search, body, headers: (init.headers ?? {}) as Record<string, string> });
    const route = `${method} ${u.pathname}`;
    let m: RegExpMatchArray | null;
    const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (route === 'GET /v1/programs') return ok({ object: 'list', data: db.programs, has_more: false }); // the 2026-11-01 envelope
    if (route === 'POST /v1/programs') {
      const { widget, selfReferralPolicy, ...rest } = body!;
      const settings = { selfReferralPolicy: selfReferralPolicy ?? 'review', widget: widget ?? { destinationUrl: null } };
      const row: Row = { id: id('prg'), status: 'active', cookieWindowDays: 60, ...rest, settings };
      db.programs.push(row);
      return ok(row);
    }
    if ((m = route.match(/^PATCH \/v1\/programs\/(\w+)$/))) {
      const row = db.programs.find((p) => p.id === m![1])!;
      const { destinationUrl, selfReferralPolicy, ...rest } = body!;
      Object.assign(row, rest);
      const settings = row.settings as Record<string, unknown>;
      if (destinationUrl) settings.widget = { destinationUrl };
      if (selfReferralPolicy) settings.selfReferralPolicy = selfReferralPolicy;
      return ok(row);
    }
    if (route === 'GET /v1/commission-rules') return ok(db.rules.filter((r) => r.programId === u.searchParams.get('programId')).reverse());
    if (route === 'POST /v1/commission-rules') {
      const prior = db.rules.filter((r) => r.programId === body!.programId).length;
      const row: Row = { id: id('crv'), programId: body!.programId, version: prior + 1, config: { appliesTo: 'gross', recurring: { type: 'lifetime' }, holdDays: 30, rounding: 'half_even', overrides: [], ...(body!.config as object) } };
      db.rules.push(row);
      return ok(row);
    }
    if ((m = route.match(/^(GET|PUT) \/v1\/programs\/(\w+)\/stripe-credits$/))) {
      const pid = m[2]!;
      if (m[1] === 'PUT') {
        const { secretKey, ...rest } = body!;
        const had = db.credits.get(pid)?.hasOwnKey === true;
        db.credits.set(pid, { id: pid, ...rest, metadataKey: rest.metadataKey ?? null, hasOwnKey: had || Boolean(secretKey) });
      }
      return ok(db.credits.get(pid) ?? { id: pid, enabled: false, referrerMatch: 'billing_link', metadataKey: null, refereeRewards: false, hasOwnKey: false });
    }
    if (route === 'GET /v1/webhook-endpoints') return ok(db.hooks);
    if (route === 'POST /v1/webhook-endpoints') {
      const row: Row = { id: id('whe'), alertContacts: [], ...body! };
      db.hooks.push(row);
      return ok({ ...row, secret: 'whsec_TOPSECRET' });
    }
    if ((m = route.match(/^PATCH \/v1\/webhook-endpoints\/(\w+)$/))) return ok(Object.assign(db.hooks.find((h) => h.id === m![1])!, body));
    if (route === 'GET /v1/api-keys') return ok(db.keys.filter((k) => !u.searchParams.get('owner') || k.owner === u.searchParams.get('owner')));
    if (route === 'POST /v1/api-keys') {
      const mk = (livemode: boolean) => {
        const row = { id: id('key'), name: body!.name, owner: body!.owner ?? null, revokedAt: null, livemode };
        db.keys.push(row);
        return { ...row, key: `rk_${livemode ? 'live' : 'test'}_SECRETKEY` };
      };
      return ok({ pairId: 'kpair_1', live: mk(true), test: mk(false) });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: route } }), { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls, db };
}

function harness(acct: ReturnType<typeof fakeAccount>, extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { REFERALLI_API_KEY: 'rk_test_admin', REFERALLI_API_URL: 'http://api.test', REFERALLI_CONFIG_DIR: dir(), ...extraEnv },
    fetchFn: acct.fetchFn,
    sleep: async () => {},
    openBrowser: () => false,
    signal: new AbortController().signal,
  };
  return { io: value, out, err, text: () => [...out, ...err].join('\n') };
}

const dir = () => mkdtempSync(join(tmpdir(), 'referalli-apply-'));

const YAML = `
programs:
  - slug: pro
    name: Pro referrals
    cookieWindowDays: 30
    destinationUrl: https://example.com/signup
    selfReferralPolicy: reject
    commissionRule:
      base: { kind: percent, bps: 2000 }
      holdDays: 14
    stripeCredits:
      enabled: true
      referrerMatch: metadata
      metadataKey: referalli_ref
      secretKeyEnv: STRIPE_CREDIT_KEY
webhooks:
  - url: https://example.com/hooks/referalli
    topics: [commission.created, referral.created]
    programs: [pro]
apiKeys:
  - name: ci
    owner: ci@example.com
    scopes: [full]
    programs: [pro]
`;

function writeConfig(text = YAML) {
  const file = join(dir(), 'referalli.yaml');
  writeFileSync(file, text);
  return file;
}

const ENV = { STRIPE_CREDIT_KEY: 'rk_test_STRIPESECRET' };
const SECRETS = ['whsec_TOPSECRET', 'rk_live_SECRETKEY', 'rk_test_SECRETKEY', 'rk_test_STRIPESECRET'];

describe('referalli plan / apply', () => {
  it('plans every create on an empty account, writes nothing, and --check exits 2', async () => {
    const acct = fakeAccount();
    const file = writeConfig();
    const t = harness(acct, ENV);
    expect(await runCli(['plan', file], t.io)).toBe(0);
    const text = t.text();
    expect(text).toContain('+ create program "pro"');
    expect(text).toContain('    cookieWindowDays: 30');
    expect(text).toContain('+ create commissionRule "pro"');
    expect(text).toContain('+ create stripeCredits "pro"');
    expect(text).toContain('    secretKey: "(from $STRIPE_CREDIT_KEY)"');
    expect(text).toContain('+ create webhook https://example.com/hooks/referalli');
    expect(text).toContain('+ create apiKey "ci" (owner ci@example.com)');
    expect(text).toContain('Plan: 5 to create, 0 to update, 0 unchanged.');
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(acct.calls.every((c) => c.method === 'GET')).toBe(true);

    const c = harness(acct, ENV);
    expect(await runCli(['apply', file, '--check'], c.io)).toBe(2);
    expect(c.text()).toContain('Drift');
  });

  it('apply creates in order with stable Idempotency-Keys and program refs resolved; a re-plan is all unchanged', async () => {
    const acct = fakeAccount();
    const file = writeConfig();
    const t = harness(acct, ENV);
    expect(await runCli(['apply', file], t.io)).toBe(0);
    const writes = acct.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/programs',
      'POST /v1/commission-rules',
      'PUT /v1/programs/prg_1/stripe-credits',
      'POST /v1/webhook-endpoints',
      'POST /v1/api-keys',
    ]);
    expect(writes[0]!.body).toMatchObject({ slug: 'pro', name: 'Pro referrals', widget: { destinationUrl: 'https://example.com/signup' } });
    expect(writes[2]!.body).toMatchObject({ enabled: true, secretKey: 'rk_test_STRIPESECRET' });
    expect(writes[3]!.body).toMatchObject({ programIds: ['prg_1'], status: 'active' });
    expect(writes[4]!.body).toMatchObject({ name: 'ci', owner: 'ci@example.com', mode: 'both', programIds: ['prg_1'] });
    for (const w of writes.filter((c) => c.method === 'POST')) expect(w.headers['idempotency-key']).toMatch(/^referalli-apply-\w+-[0-9a-f]{40}$/);
    // Secrets are shown once, after apply; never the Stripe key read from the environment.
    expect(t.text()).toContain('whsec_TOPSECRET');
    expect(t.text()).toContain('rk_live_SECRETKEY');
    expect(t.text()).not.toContain('rk_test_STRIPESECRET');

    // Same file again: same keys for the same requests, and nothing to do.
    const again = harness(acct, ENV);
    expect(await runCli(['apply', file, '--check'], again.io)).toBe(0);
    expect(again.text()).toContain('Plan: 0 to create, 0 to update, 5 unchanged.');
    expect(again.text()).toContain('= unchanged commissionRule "pro" (v1)');
  });

  it('shows updates as old → new, applies only the changed fields, and never re-creates an API key', async () => {
    const acct = fakeAccount();
    expect(await runCli(['apply', writeConfig()], harness(acct, ENV).io)).toBe(0);
    acct.calls.length = 0;
    const edited = writeConfig(
      YAML.replace('cookieWindowDays: 30', 'cookieWindowDays: 45')
        .replace('holdDays: 14', 'holdDays: 7')
        .replace('topics: [commission.created, referral.created]', 'topics: [commission.created]\n    status: paused'),
    );
    const plan = harness(acct, ENV);
    expect(await runCli(['plan', edited, '--check'], plan.io)).toBe(2);
    const text = plan.text();
    expect(text).toContain('~ update program "pro"\n    cookieWindowDays: 30 → 45');
    expect(text).toContain('~ update commissionRule "pro" (v1)\n    holdDays: 14 → 7');
    expect(text).toContain('    topics: ["commission.created","referral.created"] → ["commission.created"]');
    expect(text).toContain('    status: "active" → "paused"');
    expect(text).toContain('= unchanged stripeCredits "pro"'); // the program's own key is set: never re-sent
    expect(text).toContain('= unchanged apiKey "ci"');

    expect(await runCli(['apply', edited], harness(acct, ENV).io)).toBe(0);
    const writes = acct.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /v1/programs/prg_1', 'POST /v1/commission-rules', 'PATCH /v1/webhook-endpoints/whe_3']);
    expect(writes[0]!.body).toEqual({ cookieWindowDays: 45 });
    expect(acct.db.rules.at(-1)!.version).toBe(2);
  });

  it('--secret-file writes new secrets to a 0600 file and keeps them off the terminal', async () => {
    const acct = fakeAccount();
    const secretFile = join(dir(), 'secrets.json');
    const t = harness(acct, ENV);
    expect(await runCli(['apply', writeConfig(), '--secret-file', secretFile], t.io)).toBe(0);
    for (const s of SECRETS) expect(t.text()).not.toContain(s);
    const saved = JSON.parse(readFileSync(secretFile, 'utf8')) as Record<string, string>;
    expect(saved).toEqual({
      'webhook https://example.com/hooks/referalli': 'whsec_TOPSECRET',
      'apiKey ci (ci@example.com) live': 'rk_live_SECRETKEY',
      'apiKey ci (ci@example.com) test': 'rk_test_SECRETKEY',
    });
    if (process.platform !== 'win32') expect(statSync(secretFile).mode & 0o777).toBe(0o600);

    // An existing secret file is refused before anything is created.
    const before = acct.calls.length;
    const fresh = fakeAccount();
    const t2 = harness(fresh, ENV);
    expect(await runCli(['apply', writeConfig(), '--secret-file', secretFile], t2.io)).toBe(1);
    expect(t2.text()).toContain('already exists');
    expect(fresh.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(acct.calls.length).toBe(before);
  });

  it('apply --plan only plans; JSON files work too', async () => {
    const acct = fakeAccount();
    const file = writeConfig(JSON.stringify({ programs: [{ slug: 'basic', name: 'Basic' }] }));
    const t = harness(acct);
    expect(await runCli(['apply', file, '--plan'], t.io)).toBe(0);
    expect(t.text()).toContain('+ create program "basic"');
    expect(acct.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('rejects secrets, typos, unknown program refs and a missing key env var with a clear message', async () => {
    const cases: Array<[string, string, Record<string, string>?]> = [
      ['programs:\n  - slug: pro\n    stripeCredits: { enabled: true, secretKey: rk_test_x }', 'secrets never go in the file'],
      ['programs:\n  - slug: pro\n    cookieWindow: 30', 'unknown field "cookieWindow"'],
      ['webhooks:\n  - url: https://x.test/h\n    programs: [nope]', 'unknown program "nope"'],
      ['programs:\n  - slug: pro\n    stripeCredits: { enabled: true, secretKeyEnv: MISSING_KEY }', 'MISSING_KEY is not set'],
      ['programs: [', 'referalli.yaml'],
    ];
    for (const [text, message] of cases) {
      const t = harness(fakeAccount());
      expect(await runCli(['plan', writeConfig(text)], t.io)).toBe(1);
      expect(t.text()).toContain(message);
      expect(t.text()).not.toContain('rk_test_x');
    }
  });
});
