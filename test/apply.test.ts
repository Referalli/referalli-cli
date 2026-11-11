import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type Io } from '../src/index.js';

/** An in-memory account behind the /v1 routes `plan`/`apply` use; records every call. */
function fakeAccount() {
  type Row = Record<string, unknown> & { id: string };
  const db = {
    programs: [] as Row[],
    rules: [] as Row[],
    credits: new Map<string, Row>(),
    hooks: [] as Row[],
    keys: [] as Row[],
    conns: [] as Row[],
    auth: [] as Row[],
    payouts: [] as Row[],
    email: { provider: null, hasApiKey: false, fromAddress: null, fromName: null } as Record<string, unknown>,
    consent: { mode: 'none' } as Record<string, unknown>,
    hosted: { consent: { adapter: 'none', config: {} }, chat: null, customOrigins: {} } as Record<string, unknown>,
    selfKey: 'key_self',
    selfPrograms: null as string[] | null,
  };
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
      const { widget, selfReferralPolicy, notificationEmails, howItWorksMd, ...rest } = body!;
      const settings = {
        selfReferralPolicy: selfReferralPolicy ?? 'review',
        widget: widget ?? { destinationUrl: null },
        notificationEmails: notificationEmails ?? { enabled: true },
        howItWorksMd: howItWorksMd ?? '',
      };
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
      for (const k of ['riskPolicy', 'widget', 'notificationEmails', 'howItWorksMd']) {
        if (row[k] !== undefined) settings[k] = row[k]; // GET returns these under settings
        delete row[k];
      }
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
        db.credits.set(pid, { id: pid, ...rest, metadataKey: rest.metadataKey ?? null, balanceCurrency: rest.balanceCurrency ?? null, createCustomerIfMissing: rest.createCustomerIfMissing ?? null, hasOwnKey: had || Boolean(secretKey) });
      }
      return ok(db.credits.get(pid) ?? { id: pid, enabled: false, referrerMatch: 'billing_link', metadataKey: null, refereeRewards: false, balanceCurrency: null, createCustomerIfMissing: null, waitForCustomer: false, hasOwnKey: false });
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
    // The live API answers in the list envelope (2026-11-01); a bare array hid `conns.filter is not a function`.
    if (route === 'GET /v1/billing/connections') return ok({ data: db.conns, has_more: false });
    if (route === 'POST /v1/billing/connections') {
      const row: Row = { id: id('bcon'), status: 'active', programIds: null, customerRefMetadataKey: null, filter: null, ...body! };
      db.conns.push(row);
      return ok({ ...row, webhookSecret: 'whsec_BILLINGSECRET' });
    }
    if ((m = route.match(/^PATCH \/v1\/billing\/connections\/(\w+)$/))) return ok(Object.assign(db.conns.find((c) => c.id === m![1])!, body));
    // A plain array today; listAll takes either.
    if (route === 'GET /v1/auth/connections') return ok(db.auth);
    if (route === 'POST /v1/auth/connections') {
      const row: Row = { id: id('acon'), name: '', status: 'active', autoEnrollUsers: false, destinationUrl: null, resolveBillingCustomers: false, allowedOrigins: [], ...body!, ...(['atlas', 'custom'].includes(String(body!.provider)) ? { instanceId: body!.instanceId ?? null, appId: body!.appId ?? null } : {}) };
      db.auth.push(row);
      return ok({ ...row, secret: 'whsec_AUTHSECRET' });
    }
    if ((m = route.match(/^PATCH \/v1\/auth\/connections\/(\w+)$/))) return ok(Object.assign(db.auth.find((c) => c.id === m![1])!, body));
    if (route === 'GET /v1/cli/topics') return ok({ topics: ['referral.created', 'referral.voided', 'commission.earned', 'commission.reversed', 'commission.settled', 'payout.sent'] });
    if (route === 'GET /v1/me') return ok({ apiKey: { id: db.selfKey, programIds: db.selfPrograms } });
    if ((m = route.match(/^DELETE \/v1\/(webhook-endpoints|billing\/connections|auth\/connections)\/(\w+)$/))) {
      const table = { 'webhook-endpoints': db.hooks, 'billing/connections': db.conns, 'auth/connections': db.auth }[m[1]!]!;
      table.splice(table.findIndex((r) => r.id === m![2]), 1);
      return ok({ ok: true });
    }
    if ((m = route.match(/^DELETE \/v1\/api-keys\/(\w+)$/))) {
      db.keys.find((k) => k.id === m![1])!.revokedAt = '2026-11-11T00:00:00Z';
      return ok({ ok: true });
    }
    if (route === 'GET /v1/payout-connections') return ok(db.payouts);
    if ((m = route.match(/^(PUT|DELETE) \/v1\/payout-connections\/(\w+)$/))) {
      db.payouts = db.payouts.filter((p) => p.provider !== m![2]);
      if (m[1] === 'PUT') db.payouts.push({ id: m[2]!, provider: m[2]!, env: (body!.env as string) ?? 'live', status: 'active' });
      return ok({ provider: m[2] });
    }
    if (route === 'GET /v1/email/settings') return ok(db.email);
    if (route === 'PUT /v1/email/settings') {
      const { apiKey, ...rest } = body!;
      Object.assign(db.email, rest, apiKey ? { hasApiKey: true } : {});
      return ok(db.email);
    }
    if (route === 'GET /v1/org/tracking-consent') return ok({ ...db.consent, configured: true, adapters: [] });
    if (route === 'PUT /v1/org/tracking-consent') return ok((db.consent = body!));
    if (route === 'GET /v1/org/hosted-pages') return ok(db.hosted);
    if (route === 'PUT /v1/org/hosted-pages') {
      const chat = body!.chat as Record<string, unknown> | null;
      db.hosted = { ...body!, chat: chat ? { adapter: chat.adapter, config: chat.config, hasIdentitySecret: Boolean(chat.identitySecret) } : null };
      return ok(db.hosted);
    }
    if ((m = route.match(/^PUT \/v1\/programs\/(\w+)\/referee-reward$/))) {
      const { enabled, ...reward } = body!;
      (db.programs.find((p) => p.id === m![1])!.settings as Record<string, unknown>).refereeReward = enabled === false ? null : { kind: 'store_credit', ...reward, currency: String(reward.currency ?? 'usd').toLowerCase() };
      return ok({});
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
    topics: [commission.earned, referral.created]
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
        .replace('topics: [commission.earned, referral.created]', 'topics: [commission.earned]\n    status: paused'),
    );
    const plan = harness(acct, ENV);
    expect(await runCli(['plan', edited, '--check'], plan.io)).toBe(2);
    const text = plan.text();
    expect(text).toContain('~ update program "pro"\n    cookieWindowDays: 30 → 45');
    expect(text).toContain('~ update commissionRule "pro" (v1)\n    holdDays: 14 → 7');
    expect(text).toContain('    topics: ["commission.earned","referral.created"] → ["commission.earned"]');
    expect(text).toContain('    status: "active" → "paused"');
    expect(text).toContain('= unchanged stripeCredits "pro"'); // the program's own key is set: never re-sent
    expect(text).toContain('= unchanged apiKey "ci"');

    expect(await runCli(['apply', edited], harness(acct, ENV).io)).toBe(0);
    const writes = acct.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /v1/programs/prg_1', 'POST /v1/commission-rules', 'PATCH /v1/webhook-endpoints/whe_3']);
    expect(writes[0]!.body).toEqual({ cookieWindowDays: 45 });
    expect(acct.db.rules.at(-1)!.version).toBe(2);
  });

  it('manages balanceCurrency and createCustomerIfMissing, and never drops them by leaving them out of the PUT', async () => {
    const acct = fakeAccount();
    const withBoth = writeConfig(YAML.replace('secretKeyEnv: STRIPE_CREDIT_KEY', 'secretKeyEnv: STRIPE_CREDIT_KEY\n      balanceCurrency: EUR\n      createCustomerIfMissing: { metadata: { source: referalli } }'));
    expect(await runCli(['apply', withBoth], harness(acct, ENV).io)).toBe(0);
    const put = acct.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/stripe-credits'))!;
    expect(put.body).toMatchObject({ balanceCurrency: 'eur', createCustomerIfMissing: { metadata: { source: 'referalli' } } });

    const again = harness(acct, ENV);
    expect(await runCli(['plan', withBoth, '--check'], again.io)).toBe(0);
    expect(again.text()).toContain('= unchanged stripeCredits "pro"');

    // Removed from the file: the plan says so instead of the PUT switching them off unseen.
    const without = harness(acct, ENV);
    expect(await runCli(['plan', writeConfig(), '--check'], without.io)).toBe(2);
    expect(without.text()).toContain('    balanceCurrency: "eur" → null');
  });

  it('sends waitForCustomer on every PUT, so leaving it out of the file shows as turning it off', async () => {
    const acct = fakeAccount();
    const waiting = writeConfig(YAML.replace('secretKeyEnv: STRIPE_CREDIT_KEY', 'secretKeyEnv: STRIPE_CREDIT_KEY\n      waitForCustomer: true'));
    expect(await runCli(['apply', waiting], harness(acct, ENV).io)).toBe(0);
    const put = acct.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/stripe-credits'))!;
    expect(put.body).toMatchObject({ waitForCustomer: true });

    const again = harness(acct, ENV);
    expect(await runCli(['plan', waiting, '--check'], again.io)).toBe(0);
    expect(again.text()).toContain('= unchanged stripeCredits "pro"');

    const without = harness(acct, ENV);
    expect(await runCli(['plan', writeConfig(), '--check'], without.io)).toBe(2);
    expect(without.text()).toContain('    waitForCustomer: true → false');
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

  it('billing connections: created by name with the secret to the secret file, unchanged on re-plan, drift exits 2 and PATCHes', async () => {
    const BILLING = `
programs:
  - slug: pro
billingConnections:
  - name: formflow-generic
    provider: generic
    programs: [pro]
    customerRefMetadataKey: tenant_owner
`;
    const acct = fakeAccount();
    const secretFile = join(dir(), 'secrets.json');
    const t = harness(acct);
    expect(await runCli(['apply', writeConfig(BILLING), '--secret-file', secretFile], t.io)).toBe(0);
    expect(t.text()).toContain('+ create billingConnection "formflow-generic"');
    expect(t.text()).not.toContain('whsec_BILLINGSECRET');
    expect(JSON.parse(readFileSync(secretFile, 'utf8'))).toEqual({ 'billingConnection "formflow-generic"': 'whsec_BILLINGSECRET' });
    const post = acct.calls.find((c) => c.method === 'POST' && c.path === '/v1/billing/connections')!;
    expect(post.body).toEqual({ name: 'formflow-generic', provider: 'generic', programIds: [acct.db.programs[0]!.id], customerRefMetadataKey: 'tenant_owner' });
    expect(post.headers['idempotency-key']).toMatch(/^referalli-apply-billing-/);

    const again = harness(acct);
    expect(await runCli(['plan', writeConfig(BILLING), '--check'], again.io)).toBe(0);
    expect(again.text()).toContain('= unchanged billingConnection "formflow-generic"');

    const drifted = writeConfig(BILLING.replace('tenant_owner', 'owner_id').replace('programs: [pro]\n', 'programs: [pro]\n    status: paused\n'));
    const check = harness(acct);
    expect(await runCli(['plan', drifted, '--check'], check.io)).toBe(2);
    expect(check.text()).toContain('    customerRefMetadataKey: "tenant_owner" → "owner_id"');
    const writes = acct.calls.length;
    expect(await runCli(['apply', drifted], harness(acct).io)).toBe(0);
    const patch = acct.calls.slice(writes).find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ status: 'paused', customerRefMetadataKey: 'owner_id' });
    expect(acct.db.conns).toHaveLength(1);

    // A provider can't change under the same name; secrets stay out of the file.
    const t2 = harness(acct);
    expect(await runCli(['plan', writeConfig(BILLING.replace('provider: generic', 'provider: paddle'))], t2.io)).toBe(1);
    expect(t2.text()).toContain("a provider can't be changed");
    const t3 = harness(fakeAccount());
    expect(await runCli(['plan', writeConfig('billingConnections:\n  - { name: s, provider: stripe, stripeKey: sk_x }')], t3.io)).toBe(1);
    expect(t3.text()).toContain('secrets never go in the file');
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

  it('publicPage and riskPolicy: diffs only the keys the file names, PATCHes the live block with them applied', async () => {
    const acct = fakeAccount();
    acct.db.programs.push({
      id: 'prg_live',
      slug: 'ff',
      name: 'ff',
      publicPage: { pitch: 'Earn 20%', autoApprove: true },
      settings: { widget: { destinationUrl: null }, riskPolicy: { holdBotScore: 0.9, holdDisposableEmail: true } },
    });
    const file = writeConfig('programs:\n  - slug: ff\n    publicPage: { autoApprove: false }\n    riskPolicy: { holdBotScore: 0.8 }\n');
    const t = harness(acct, ENV);
    expect(await runCli(['plan', file], t.io)).toBe(0);
    expect(t.text()).toContain('~ update program "ff"');
    expect(t.text()).toContain('Plan: 0 to create, 1 to update, 0 unchanged.');

    expect(await runCli(['apply', file], harness(acct, ENV).io)).toBe(0);
    const patch = acct.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({
      publicPage: { pitch: 'Earn 20%', autoApprove: false },
      riskPolicy: { holdBotScore: 0.8, holdDisposableEmail: true },
    });
    const again = harness(acct, ENV);
    expect(await runCli(['plan', file], again.io)).toBe(0);
    expect(again.text()).toContain('Plan: 0 to create, 0 to update, 1 unchanged.');

    const bad = harness(acct, ENV);
    expect(await runCli(['plan', writeConfig('programs:\n  - slug: ff\n    publicPage: { autoapprove: false }\n')], bad.io)).not.toBe(0);
    expect(bad.text()).toContain('autoapprove');
  });

  it('plans billing connections from the list envelope (FormFlow: conns.filter is not a function)', async () => {
    const acct = fakeAccount();
    acct.db.conns.push({ id: 'bcon_1', name: 'formflow-generic', provider: 'generic', status: 'active', programIds: null, customerRefMetadataKey: null, filter: null });
    const t = harness(acct, ENV);
    expect(await runCli(['plan', writeConfig('billingConnections:\n  - name: formflow-generic\n    provider: generic\n')], t.io)).toBe(0);
    expect(t.text()).toContain('Plan: 0 to create, 0 to update, 1 unchanged.');
  });

  describe('authConnections', () => {
    const FILE = `programs:
  - slug: pro
authConnections:
  - provider: atlas
    instanceId: inst_1
    program: pro
    autoEnrollUsers: true
    destinationUrl: https://example.com/signup
    allowedOrigins: [https://b.test, https://a.test]
`;

    it('creates once, prints the secret once (never to --secret-file), then is unchanged and catches drift', async () => {
      const acct = fakeAccount();
      const file = writeConfig(FILE);
      const check = harness(acct, ENV);
      expect(await runCli(['plan', file, '--check'], check.io)).toBe(2);
      expect(check.text()).toContain('+ create authConnection "atlas inst_1 pro"');
      expect(check.text()).not.toContain('whsec_');

      const secretFile = join(dir(), 'secrets.json');
      const t = harness(acct, ENV);
      expect(await runCli(['apply', file, '--secret-file', secretFile], t.io)).toBe(0);
      expect(t.text().match(/whsec_AUTHSECRET/g)).toHaveLength(1);
      expect(t.text()).toContain('shown once');
      expect(existsSync(secretFile)).toBe(false);
      const post = acct.calls.find((c) => c.method === 'POST' && c.path === '/v1/auth/connections')!;
      expect(post.body).toEqual({ provider: 'atlas', programId: acct.db.programs[0]!.id, instanceId: 'inst_1', autoEnrollUsers: true, destinationUrl: 'https://example.com/signup', allowedOrigins: ['https://a.test', 'https://b.test'] });
      expect(post.headers['idempotency-key']).toMatch(/^referalli-apply-auth-/);

      const same = harness(acct, ENV);
      expect(await runCli(['plan', file, '--check'], same.io)).toBe(0);
      expect(same.text()).toContain('= unchanged authConnection "atlas inst_1 pro"');

      acct.db.auth[0]!.autoEnrollUsers = false;
      const drift = harness(acct, ENV);
      expect(await runCli(['plan', file, '--check'], drift.io)).toBe(2);
      expect(drift.text()).toContain('autoEnrollUsers: false → true');
      expect(await runCli(['apply', file], harness(acct, ENV).io)).toBe(0);
      expect(acct.calls.at(-1)).toMatchObject({ method: 'PATCH', path: `/v1/auth/connections/${acct.db.auth[0]!.id}`, body: { autoEnrollUsers: true } });
      expect(acct.calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('fields POST ignores go in a PATCH after the create; a failed PATCH has already printed the secret', async () => {
      const acct = fakeAccount();
      const file = writeConfig(`${FILE}    status: paused\n`);
      expect(await runCli(['apply', file], harness(acct, ENV).io)).toBe(0);
      expect(acct.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'paused' } });

      const failing = fakeAccount();
      const refused = (async (url: string, init: RequestInit) =>
        init.method === 'PATCH' && url.includes('/auth/connections/') ? new Response('{}', { status: 500 }) : failing.fetchFn(url, init)) as typeof fetch;
      const t = harness({ ...failing, fetchFn: refused }, ENV);
      expect(await runCli(['apply', file], t.io)).toBe(1);
      expect(t.text()).toContain('whsec_AUTHSECRET');
    });

    it('matches on provider + instance + program: another program or instance is a new connection', async () => {
      const acct = fakeAccount();
      acct.db.programs.push({ id: 'prg_a', slug: 'pro', status: 'active', settings: {} }, { id: 'prg_b', slug: 'other', status: 'active', settings: {} });
      acct.db.auth.push(
        { id: 'acon_other', provider: 'clerk', programId: 'prg_b', status: 'active', allowedOrigins: [] },
        { id: 'acon_inst', provider: 'atlas', programId: 'prg_a', instanceId: 'inst_2', appId: null, status: 'active', allowedOrigins: [] },
      );
      const t = harness(acct, ENV);
      expect(await runCli(['plan', writeConfig('authConnections:\n  - { provider: clerk, program: pro }\n  - { provider: atlas, instanceId: inst_1, program: pro }\n  - { provider: atlas, instanceId: inst_2, program: pro }\n')], t.io)).toBe(0);
      expect(t.text()).toContain('Plan: 2 to create, 0 to update, 1 unchanged.');

      acct.db.auth.push({ id: 'acon_dup', provider: 'atlas', programId: 'prg_a', instanceId: 'inst_2', appId: null, status: 'paused', allowedOrigins: [] });
      const dup = harness(acct, ENV);
      expect(await runCli(['plan', writeConfig('authConnections:\n  - { provider: atlas, instanceId: inst_2, program: pro }\n')], dup.io)).toBe(1);
      expect(dup.text()).toContain('acon_inst, acon_dup');
    });

    it.each([
      ['provider: atlas, instanceId: i, program: pro, autoEnroll: true', 'unknown field "autoEnroll"'],
      ['provider: atlas, instanceId: i, program: pro, secret: abcdefgh', 'unknown field "secret"'],
      ['provider: atlas, program: pro', 'exactly one of instanceId or appId'],
      ['provider: atlas, instanceId: i, appId: a, program: pro', 'exactly one of instanceId or appId'],
      ['provider: clerk, instanceId: i, program: pro', 'for provider atlas or custom'],
      ['provider: clerk', '"program"'],
      ['provider: clerk, program: pro, status: off', 'active or paused'],
      ['provider: clerk, program: pro, allowedOrigins: https://a.test', 'expected a list'],
      ['provider: clerk, program: nope', 'unknown program "nope"'],
    ])('refuses { %s }', async (row, message) => {
      const t = harness(fakeAccount(), ENV);
      expect(await runCli(['plan', writeConfig(`programs:\n  - slug: pro\nauthConnections:\n  - { ${row} }\n`)], t.io)).toBe(1);
      expect(t.text()).toContain(message);
    });

    it('refuses the same connection listed twice', async () => {
      const t = harness(fakeAccount(), ENV);
      expect(await runCli(['plan', writeConfig('authConnections:\n  - { provider: clerk, program: pro }\n  - { provider: clerk, program: pro }\n')], t.io)).toBe(1);
      expect(t.text()).toContain('listed twice');
    });
  });

  describe('webhooks by id, topics, managedBy and --prune (R-10, R-19, R-20)', () => {
    const hook = (over: Record<string, unknown> = {}) => ({ id: 'whe_9', url: 'https://old.test/h', topics: ['referral.created'], programIds: null, status: 'active', alertContacts: [], ...over });

    it('an id keeps the endpoint (and its secret) when the url moves', async () => {
      const acct = fakeAccount();
      acct.db.hooks.push(hook());
      const file = writeConfig('webhooks:\n  - id: whe_9\n    url: https://new.test/h\n    topics: [referral.created]\n');
      const t = harness(acct);
      expect(await runCli(['plan', file], t.io)).toBe(0);
      expect(t.text()).toContain('~ update webhook url: https://old.test/h → https://new.test/h');
      expect(t.text()).toContain('    url: "https://old.test/h" → "https://new.test/h"');
      expect(await runCli(['apply', file], harness(acct).io)).toBe(0);
      expect(acct.calls.filter((c) => c.method !== 'GET')).toEqual([expect.objectContaining({ method: 'PATCH', path: '/v1/webhook-endpoints/whe_9', body: { url: 'https://new.test/h' } })]);
      expect(acct.db.hooks).toHaveLength(1);
      const again = harness(acct);
      expect(await runCli(['plan', file, '--check'], again.io)).toBe(0);

      const gone = harness(acct);
      expect(await runCli(['plan', writeConfig('webhooks:\n  - id: whe_404\n    url: https://new.test/h\n')], gone.io)).toBe(1);
      expect(gone.text()).toContain('no such endpoint');
    });

    it('an unknown topic is refused with a suggestion; * and prefix.* pass', async () => {
      const t = harness(fakeAccount());
      expect(await runCli(['plan', writeConfig('webhooks:\n  - url: https://x.test/h\n    topics: [commission.created]\n')], t.io)).toBe(1);
      expect(t.text()).toContain('unknown topic "commission.created" (did you mean commission.');
      const ok = harness(fakeAccount());
      expect(await runCli(['plan', writeConfig('webhooks:\n  - url: https://x.test/h\n    topics: ["*", "referral.*"]\n')], ok.io)).toBe(0);
      const prefix = harness(fakeAccount());
      expect(await runCli(['plan', writeConfig('webhooks:\n  - url: https://x.test/h\n    topics: [nothing.*]\n')], prefix.io)).toBe(1);
    });

    it("an Atlas-managed endpoint: its topics aren't drift, it needn't be in the file, and --prune never deletes it", async () => {
      const acct = fakeAccount();
      acct.db.hooks.push(hook({ id: 'whe_atlas', url: 'https://api.atlasauth.net/v1/referrals/inbound/i', topics: ['referral.*'], managedBy: 'atlas' }));
      const declared = harness(acct);
      expect(await runCli(['plan', writeConfig('webhooks:\n  - url: https://api.atlasauth.net/v1/referrals/inbound/i\n    managedBy: atlas\n'), '--check'], declared.io)).toBe(0);
      expect(declared.text()).toContain('= unchanged webhook https://api.atlasauth.net/v1/referrals/inbound/i');
      const omitted = harness(acct);
      expect(await runCli(['plan', writeConfig('webhooks: []\n'), '--prune', '--check'], omitted.io)).toBe(0);
      expect(omitted.text()).not.toContain('delete');
    });

    it('--prune deletes what the file dropped, last, but never the calling key or its twin, nor anything outside the scope', async () => {
      const acct = fakeAccount();
      acct.db.programs.push({ id: 'prg_a', slug: 'pro', status: 'active', settings: {} }, { id: 'prg_b', slug: 'other', status: 'active', settings: {} });
      acct.db.hooks.push(hook({ id: 'whe_gone', url: 'https://gone.test/h', programIds: ['prg_a'] }), hook({ id: 'whe_other', url: 'https://other.test/h', programIds: ['prg_b'] }));
      acct.db.keys.push(
        { id: 'key_self', name: 'deploy', owner: null, revokedAt: null, pairId: 'kp_1', livemode: true },
        { id: 'key_twin', name: 'deploy', owner: null, revokedAt: null, pairId: 'kp_1', livemode: false },
        { id: 'key_old', name: 'old', owner: null, revokedAt: null, programIds: ['prg_a'], livemode: true },
        { id: 'key_wide', name: 'wide', owner: null, revokedAt: null, programIds: null, livemode: true },
      );
      const file = writeConfig('programs:\n  - slug: pro\nwebhooks:\n  - url: https://keep.test/h\n    programs: [pro]\napiKeys: []\n');

      const plain = harness(acct);
      expect(await runCli(['plan', file], plain.io)).toBe(0);
      expect(plain.text()).not.toContain('delete');

      const t = harness(acct);
      expect(await runCli(['plan', file, '--prune'], t.io)).toBe(0);
      expect(t.text()).toContain('- delete webhook https://gone.test/h (whe_gone)');
      expect(t.text()).toContain('- delete apiKey "old" live (key_old, revoked)');
      expect(t.text()).not.toContain('other.test'); // another program's: outside the file's programs
      expect(t.text()).not.toContain('key_wide'); // org-wide: not wholly inside the scope
      expect(t.text()).not.toContain('key_self');
      expect(t.text()).not.toContain('key_twin');
      expect(t.text()).toContain('Plan: 1 to create, 0 to update, 2 to delete, 1 unchanged.');

      expect(await runCli(['apply', file, '--prune'], harness(acct).io)).toBe(0);
      const writes = acct.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
      expect(writes.slice(-3)).toEqual(['POST /v1/webhook-endpoints', 'DELETE /v1/webhook-endpoints/whe_gone', 'DELETE /v1/api-keys/key_old']);
      expect(acct.db.hooks.map((h) => h.id)).toContain('whe_other');
    });
  });

  it('R-11: payouts, email, consent, hosted pages, referee reward, widget, brand and tokenVerification; secrets by env name; then unchanged', async () => {
    const acct = fakeAccount();
    const FILE = `
programs:
  - slug: pro
    termsUrl: https://example.com/terms
    brand: { name: FormFlow, logoUrl: https://example.com/logo.png }
    widget: { autoEnroll: true, destinationUrl: https://example.com/signup }
    refereeReward: { kind: store_credit, amountMinor: 500, currency: USD }
    notificationEmails: { enabled: false }
    howItWorksMd: Share your link and earn.
authConnections:
  - provider: atlas
    instanceId: inst_1
    program: pro
    tokenVerification: { preset: atlas, tenant: t.atlasauth.net }
payouts:
  - provider: stripe
    credentialEnv: { secretKey: PAYOUT_KEY }
email:
  provider: resend
  apiKeyEnv: RESEND_KEY
  fromAddress: partners@example.com
trackingConsent: { mode: cookiemunch }
hostedPages:
  consent: { adapter: cookiemunch, config: { siteId: s1 } }
`;
    const env = { PAYOUT_KEY: 'sk_live_PAYOUTSECRET', RESEND_KEY: 're_EMAILSECRET' };
    const file = writeConfig(FILE);
    const missing = harness(acct);
    expect(await runCli(['plan', file], missing.io)).toBe(1);
    expect(missing.text()).toContain('PAYOUT_KEY is not set');

    const t = harness(acct, env);
    expect(await runCli(['apply', file], t.io)).toBe(0);
    expect(t.text()).toContain('    secretKey: "(from $PAYOUT_KEY)"');
    expect(t.text()).toContain('    apiKey: "(none)" → "(from $RESEND_KEY)"');
    for (const secret of Object.values(env)) expect(t.text()).not.toContain(secret);
    const call = (method: string, path: string) => acct.calls.find((c) => c.method === method && c.path === path)!;
    expect(call('POST', '/v1/programs').body).toMatchObject({ termsUrl: 'https://example.com/terms', brand: { name: 'FormFlow' }, widget: { autoEnroll: true }, notificationEmails: { enabled: false }, howItWorksMd: 'Share your link and earn.' });
    expect(call('PUT', '/v1/payout-connections/stripe').body).toEqual({ secretKey: 'sk_live_PAYOUTSECRET' });
    expect(call('PUT', '/v1/email/settings').body).toEqual({ provider: 'resend', fromAddress: 'partners@example.com', apiKey: 're_EMAILSECRET' });
    expect(call('PUT', '/v1/org/tracking-consent').body).toEqual({ mode: 'cookiemunch' });
    expect(call('PUT', '/v1/org/hosted-pages').body).toEqual({ consent: { adapter: 'cookiemunch', config: { siteId: 's1' } }, chat: null, customOrigins: {} });
    expect(call('POST', '/v1/auth/connections').body).toMatchObject({ tokenVerification: { preset: 'atlas', tenant: 't.atlasauth.net' } });
    expect(acct.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/referee-reward'))!.body).toEqual({ kind: 'store_credit', amountMinor: 500, currency: 'USD' });

    const again = harness(acct, env);
    expect(await runCli(['plan', file, '--check'], again.io)).toBe(0);
    expect(again.text()).toContain('= unchanged refereeReward "pro"');
    expect(again.text()).toContain('= unchanged payout "stripe"');
    expect(again.text()).toContain('= unchanged email settings');

    const off = harness(acct, env);
    expect(await runCli(['plan', writeConfig(FILE.replace(/refereeReward: .*\n/, 'refereeReward: null\n')), '--check'], off.io)).toBe(2);
    expect(off.text()).toContain('~ update refereeReward "pro"');
    const bad = harness(acct, env);
    expect(await runCli(['plan', writeConfig('email:\n  apiKey: re_x\n')], bad.io)).toBe(1);
    expect(bad.text()).toContain('secrets never go in the file');
  });
});
