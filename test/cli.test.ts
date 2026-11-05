import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type Io } from '../src/index.js';

/** A fake API: routes "METHOD /path" to a handler; records every call. */
function fakeApi(routes: Record<string, (body: unknown, url: string) => unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: String(init.method), url, body, headers });
    const path = new URL(url).pathname;
    const handler = routes[`${init.method} ${path}`] ?? routes[`${init.method} ${url}`];
    if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 });
    const out = handler(body, url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function io(env: NodeJS.ProcessEnv, fetchFn: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const value: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    fetchFn,
    sleep: async () => {},
    openBrowser: () => false,
    signal: controller.signal,
  };
  return { io: value, out, err, abort: () => controller.abort() };
}

const tempEnv = () => ({ REFERALLI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'referalli-cli-')) });

describe('referalli CLI', () => {
  it('login --key checks the key and saves it mode 600', async () => {
    const env = tempEnv();
    const api = fakeApi({ 'GET /v1/org': () => ({ id: 'org_1', name: 'Acme' }) });
    const t = io(env, api.fetchFn);
    expect(await runCli(['login', '--key', 'rk_abc', '--base-url', 'http://api.test/'], t.io)).toBe(0);
    const file = join(env.REFERALLI_CONFIG_DIR, 'cli.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ baseUrl: 'http://api.test', key: 'rk_abc', orgId: 'org_1', orgName: 'Acme' });
    // Windows has no POSIX permission bits (chmod 0o600 reads back as 0o666 there).
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(api.calls[0]!.headers.authorization).toBe('Bearer rk_abc');
  });

  it('device login polls until approved, then saves the key', async () => {
    const env = tempEnv();
    let polls = 0;
    const api = fakeApi({
      'POST /v1/cli/device-codes': () => ({
        deviceCode: 'rdc_1',
        userCode: 'WDJB-MJHT',
        verificationUri: 'http://app/cli/approve',
        verificationUriComplete: 'http://app/cli/approve?code=WDJB-MJHT',
        expiresIn: 600,
        interval: 0,
      }),
      'POST /v1/cli/device-codes/token': () =>
        ++polls < 3 ? { status: 'pending' } : { status: 'approved', key: 'rk_dev', orgId: 'org_1', orgName: 'Acme', scopes: ['full'] },
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['login', '--base-url', 'http://api.test', '--no-browser'], t.io)).toBe(0);
    expect(t.out.join('\n')).toContain('WDJB-MJHT');
    expect(polls).toBe(3);
    expect(JSON.parse(readFileSync(join(env.REFERALLI_CONFIG_DIR, 'cli.json'), 'utf8')).key).toBe('rk_dev');
  });

  it('a denied device login fails and saves nothing', async () => {
    const env = tempEnv();
    const api = fakeApi({
      'POST /v1/cli/device-codes': () => ({ deviceCode: 'd', userCode: 'AAAA-BBBB', verificationUri: 'u', verificationUriComplete: 'u', expiresIn: 600, interval: 0 }),
      'POST /v1/cli/device-codes/token': () => ({ status: 'denied' }),
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['login', '--base-url', 'http://api.test', '--no-browser'], t.io)).toBe(1);
    expect(t.err.join('\n')).toContain('denied');
  });

  it('listen forwards each event with its signed headers and closes the listener', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'rk_x', REFERALLI_API_URL: 'http://api.test' };
    const forwarded: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let served = false;
    const api = fakeApi({
      'POST /v1/cli/listeners': () => ({ id: 'cli_1', secret: 'whsec_c2VjcmV0', topics: ['*'] }),
      'GET /v1/cli/listeners/cli_1/events': () => {
        if (served) return { events: [] };
        served = true;
        return {
          events: [
            {
              id: 'cle_1',
              eventId: 'evt_1',
              topic: 'referral.created',
              body: '{"id":"evt_1"}',
              headers: { 'content-type': 'application/json', 'webhook-id': 'evt_1', 'webhook-timestamp': '1', 'webhook-signature': 'v1,x' },
            },
          ],
        };
      },
      'DELETE /v1/cli/listeners/cli_1': () => ({ ok: true }),
      'POST http://localhost:9999/hook': (_b, url) => {
        void url;
        return new Response('ok', { status: 202 });
      },
    });
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.startsWith('http://localhost:9999')) {
        forwarded.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response('ok', { status: 202 });
      }
      return api.fetchFn(url, init);
    }) as typeof fetch;
    const t = io(env, fetchFn);
    expect(await runCli(['listen', '--forward-to', 'http://localhost:9999/hook', '--max-events', '1'], t.io)).toBe(0);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers['webhook-id']).toBe('evt_1');
    expect(forwarded[0]!.body).toBe('{"id":"evt_1"}');
    expect(t.out.join('\n')).toMatch(/--> referral\.created \[evt_1\]\s+<-- 202/);
    expect(t.out.join('\n')).toContain('whsec_c2VjcmV0');
    expect(api.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/cli/listeners/cli_1'))).toBe(true);
  });

  it('trigger, logs tail and api call the right endpoints', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'rk_x', REFERALLI_API_URL: 'http://api.test' };
    const api = fakeApi({
      'POST /v1/cli/trigger': (body) => ({ eventId: 'evt_9', topic: (body as { topic: string }).topic, deliveredTo: { listeners: 1, endpoints: 2 } }),
      'GET /v1/cli/logs': (_b, url) =>
        url.includes('after=')
          ? { entries: [{ seq: 2, requestId: 'req_2', method: 'POST', path: '/v1/links', status: 201, latencyMs: 5, ts: '2026-10-22T12:00:01Z' }], cursor: 2 }
          : { entries: [{ seq: 1, requestId: 'req_1', method: 'GET', path: '/v1/partners', status: 200, latencyMs: 12, ts: '2026-10-22T12:00:00Z' }], cursor: 1 },
      'GET /v1/programs': () => [{ id: 'prg_1' }],
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['trigger', 'referral.created', '--data', '{"amountMinor":5}'], t.io)).toBe(0);
    expect(api.calls.at(-1)!.body).toEqual({ topic: 'referral.created', data: { amountMinor: 5 } });
    expect(t.out.at(-1)).toContain('1 listener(s), 2 webhook endpoint(s)');

    expect(await runCli(['logs', 'tail', '--max', '2', '--wait', '0'], t.io)).toBe(0);
    expect(t.out.slice(-2)).toEqual([
      '12:00:00  GET    /v1/partners  200  12ms  req_1',
      '12:00:01  POST   /v1/links  201  5ms  req_2',
    ]);

    expect(await runCli(['api', 'get', 'v1/programs'], t.io)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)).toEqual([{ id: 'prg_1' }]);
  });

  it('trigger --stripe sends a fixture to the sandbox endpoint', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'rk_test_x', REFERALLI_API_URL: 'http://api.test' };
    const api = fakeApi({
      'POST /v1/sandbox/stripe-fixtures': () => ({
        eventId: 'evt_r',
        received: 1,
        results: [{ duplicate: false }],
        commissions: [{ id: 'cev_1', type: 'earned', amountMinor: 980, currency: 'usd' }],
      }),
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['trigger', '--stripe', 'invoice.paid', '--connection', 'bcon_1', '--data', '{"customerRef":"cus_1","eventId":"evt_r"}'], t.io)).toBe(0);
    expect(api.calls.at(-1)!.body).toEqual({ connectionId: 'bcon_1', event: 'invoice.paid', overrides: { customerRef: 'cus_1' }, eventId: 'evt_r' });
    expect(t.out.slice(-2)).toEqual(['Sent invoice.paid [evt_r]: 1 billing event(s), 1 commission event(s).', '  earned  980 usd  cev_1']);
    expect(await runCli(['trigger', '--stripe', 'invoice.paid'], t.io)).toBe(1);
    expect(t.err.at(-1)).toContain('--connection');
  });

  it('trigger --billing sends a provider-neutral fixture to the billing sandbox endpoint', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'rk_test_x', REFERALLI_API_URL: 'http://api.test' };
    const api = fakeApi({
      'POST /v1/sandbox/billing-fixtures': () => ({
        eventId: 'shopify_order_55',
        provider: 'shopify',
        nativeEvent: 'orders/paid',
        received: 1,
        results: [{ duplicate: false }],
        commissions: [{ id: 'cev_2', type: 'earned', amountMinor: 980, currency: 'usd' }],
      }),
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['trigger', '--billing', 'payment.paid', '--connection', 'bcon_2', '--data', '{"customerRef":"77","invoiceId":"55"}'], t.io)).toBe(0);
    expect(api.calls.at(-1)!.body).toEqual({ connectionId: 'bcon_2', event: 'payment.paid', overrides: { customerRef: '77', invoiceId: '55' } });
    expect(t.out.slice(-2)).toEqual([
      'Sent payment.paid (shopify orders/paid) [shopify_order_55]: 1 billing event(s), 1 commission event(s).',
      '  earned  980 usd  cev_2',
    ]);
    expect(await runCli(['trigger', '--billing', 'payment.paid'], t.io)).toBe(1);
    expect(t.err.at(-1)).toContain('--billing <event> --connection');
  });

  it('api --secret-file writes a once-shown secret to a 0600 file and keeps it off the terminal', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'k', REFERALLI_API_URL: 'http://api.test' };
    const api = fakeApi({ 'POST /v1/billing/connections': () => ({ id: 'bcon_1', webhookSecret: 'whsec_shh' }) });
    const t = io(env, api.fetchFn);
    const file = join(env.REFERALLI_CONFIG_DIR, 'billing.secret');
    expect(await runCli(['api', 'POST', '/v1/billing/connections', '--data', '{"provider":"generic"}', '--secret-file', file], t.io)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('whsec_shh\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(t.out.join('\n')).not.toContain('whsec_shh');
    // Never overwrites an existing file.
    expect(await runCli(['api', 'POST', '/v1/billing/connections', '--secret-file', file], t.io)).toBe(1);
  });

  it('explains what is wrong instead of throwing', async () => {
    const t = io(tempEnv(), fakeApi({}).fetchFn);
    expect(await runCli(['whoami'], t.io)).toBe(1);
    expect(t.err[0]).toContain('referalli login');
    expect(await runCli(['nope'], t.io)).toBe(2);
    expect(await runCli(['--bogus'], t.io)).toBe(2);
    expect(await runCli(['trigger', 'x', '--data', 'not json'], { ...t.io, env: { REFERALLI_API_KEY: 'k' } })).toBe(1);
    const apiErr = io({ REFERALLI_API_KEY: 'k', REFERALLI_API_URL: 'http://api.test' }, fakeApi({}).fetchFn);
    expect(await runCli(['api', 'GET', '/v1/x'], apiErr.io)).toBe(1);
    expect(apiErr.err[0]).toBe('API error 404 (not_found): nope');
  });

  it('events tail prints one line per event, or raw bodies with --json, and closes the listener', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'rk_x', REFERALLI_API_URL: 'http://api.test' };
    const body = JSON.stringify({ id: 'evt_1', type: 'commission.earned', data: { partnerId: 'prt_1', amountMinor: 2500, currency: 'USD' } });
    const api = fakeApi({
      'POST /v1/cli/listeners': (b) => ({ id: 'cli_2', secret: 'whsec_x', topics: (b as { topics?: string[] }).topics ?? ['*'] }),
      'GET /v1/cli/listeners/cli_2/events': () => ({ events: [{ id: 'cle_1', eventId: 'evt_1', topic: 'commission.earned', body, headers: {} }] }),
      'DELETE /v1/cli/listeners/cli_2': () => ({ ok: true }),
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['events', 'tail', '--events', 'commission.earned', '--max', '1'], t.io)).toBe(0);
    expect(api.calls[0]!.body).toEqual({ topics: ['commission.earned'] });
    expect(t.out.at(-1)).toMatch(/commission\.earned\s+evt_1 {2}partnerId=prt_1 amountMinor=2500 currency=USD$/);
    expect(await runCli(['events', 'tail', '--json', '--max', '1'], t.io)).toBe(0);
    expect(t.out.at(-1)).toBe(body);
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(await runCli(['events', 'list'], t.io)).toBe(1);
  });

  it('events tail --since backfills from /v1/events page by page, then tails live without repeats (REF-H15)', async () => {
    const env = { ...tempEnv(), REFERALLI_API_KEY: 'rk_x', REFERALLI_API_URL: 'http://api.test' };
    const ev = (id: string) => ({ id, topic: 'commission.earned', orgId: 'org_1', livemode: true, createdAt: '2026-10-23T10:00:00.000Z', data: { partnerId: 'prt_1' } });
    const pages: string[] = [];
    const api = fakeApi({
      'POST /v1/cli/listeners': () => ({ id: 'cli_3', secret: 'whsec_x', topics: ['commission.earned'] }),
      'GET /v1/events': (_b, url) => {
        pages.push(url);
        return new URL(url).searchParams.get('after')
          ? { events: [ev('evt_2')], hasMore: false, nextCursor: null }
          : { events: [ev('evt_1')], hasMore: true, nextCursor: 'evt_1' };
      },
      'GET /v1/cli/listeners/cli_3/events': () => ({
        events: [
          { id: 'cle_a', eventId: 'evt_2', topic: 'commission.earned', body: '{}', headers: {} },
          { id: 'cle_b', eventId: 'evt_3', topic: 'commission.earned', body: '{}', headers: {} },
        ],
      }),
      'DELETE /v1/cli/listeners/cli_3': () => ({ ok: true }),
    });
    const t = io(env, api.fetchFn);
    expect(await runCli(['events', 'tail', '--events', 'commission.earned', '--since', '2h', '--max', '3'], t.io)).toBe(0);
    expect(pages).toHaveLength(2);
    const first = new URL(pages[0]!).searchParams;
    expect(first.get('topics')).toBe('commission.earned');
    expect(Date.parse(first.get('since')!)).toBeLessThan(Date.now() - 7_100_000);
    expect(new URL(pages[1]!).searchParams.get('after')).toBe('evt_1');
    const lines = t.out.filter((l) => l.includes('evt_'));
    expect(lines.map((l) => /evt_\d/.exec(l)![0])).toEqual(['evt_1', 'evt_2', 'evt_3']);
    expect(await runCli(['events', 'tail', '--since', 'yesterday-ish'], t.io)).toBe(1);
  });

  it('open prints or opens the page on the configured host', async () => {
    const t = io({ ...tempEnv(), REFERALLI_API_URL: 'http://localhost:4000/' }, fakeApi({}).fetchFn);
    expect(await runCli(['open', 'docs'], t.io)).toBe(0);
    expect(t.out.at(-1)).toBe('http://localhost:4000/docs');
    const opened: string[] = [];
    const t2 = io(tempEnv(), fakeApi({}).fetchFn);
    t2.io.openBrowser = (url) => (opened.push(url), true);
    expect(await runCli(['open'], t2.io)).toBe(0);
    expect(opened).toEqual(['https://referalli.com/docs']);
    expect(await runCli(['open', 'nowhere'], t2.io)).toBe(1);
  });

  it('--version matches package.json', async () => {
    const t = io(tempEnv(), fakeApi({}).fetchFn);
    expect(await runCli(['--version'], t.io)).toBe(0);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; bin: Record<string, string> };
    expect(t.out[0]).toBe(pkg.version);
    expect(Object.keys(pkg.bin)).toEqual(['referalli']);
  });

  describe('env pull', () => {
    const tokens = {
      mode: 'test',
      live: { orgId: 'org_l', trackingToken: 'tk_live', scriptUrl: 'https://r.test/t/tk_live/aff.js', linkBaseUrl: 'https://go.ff.test', linkTemplate: '' },
      test: { orgId: 'org_t', trackingToken: 'tk_test', scriptUrl: 'https://r.test/t/tk_test/aff.js', linkBaseUrl: 'https://r.test', linkTemplate: '' },
    };
    const api = () =>
      fakeApi({
        'GET /v1/org/tracking-tokens': () => tokens,
        'GET /v1/programs': () => ({ object: 'list', data: [{ id: 'prg_t', name: 'P', status: 'active' }, { id: 'prg_old', name: 'O', status: 'archived' }], has_more: false }),
      });
    const envFor = () => ({ ...tempEnv(), REFERALLI_API_KEY: 'rk_test_1', REFERALLI_API_URL: 'http://api.test' });

    it("defaults to the key's mode and includes its single active program", async () => {
      const t = io(envFor(), api().fetchFn);
      expect(await runCli(['env', 'pull'], t.io)).toBe(0);
      expect(t.out).toContain('REFERALLI_TRACKING_TOKEN=tk_test');
      expect(t.out).toContain('NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN=tk_test');
      expect(t.out).toContain('REFERALLI_SCRIPT_URL=https://r.test/t/tk_test/aff.js');
      expect(t.out).toContain('REFERALLI_PROGRAM_ID=prg_t');
      expect(t.out.join('\n')).not.toMatch(/rk_test_1/);
      expect(t.out.join('\n')).not.toContain('REFERALLY_');
    });

    it("--mode live from a test key: live tokens, program ids left to a live key", async () => {
      const a = api();
      const t = io(envFor(), a.fetchFn);
      expect(await runCli(['env', 'pull', '--mode', 'live'], t.io)).toBe(0);
      expect(t.out).toContain('REFERALLI_TRACKING_TOKEN=tk_live');
      expect(t.out).toContain('REFERALLI_LINK_BASE_URL=https://go.ff.test');
      expect(t.out.some((l) => l.startsWith('REFERALLI_PROGRAM_ID='))).toBe(false);
      expect(a.calls.some((c) => c.url.includes('/v1/programs'))).toBe(false);
    });

    it('refuses an unknown mode', async () => {
      const t = io(envFor(), api().fetchFn);
      expect(await runCli(['env', 'pull', '--mode', 'staging'], t.io)).toBe(1);
      expect(t.err.join('\n')).toContain('--mode is live or test');
    });
  });

  describe('REFERALLY_* environment', () => {
    const org = () => fakeApi({ 'GET /v1/org': () => ({ id: 'org_1', name: 'Acme' }) });

    it('reads the old names with a one-line notice on stderr', async () => {
      const a = org();
      const t = io({ ...tempEnv(), REFERALLY_API_KEY: 'rk_test_old', REFERALLY_API_URL: 'http://old.test' }, a.fetchFn);
      expect(await runCli(['whoami'], t.io)).toBe(0);
      expect(a.calls[0]!.url).toBe('http://old.test/v1/org');
      expect(a.calls[0]!.headers.authorization).toBe('Bearer rk_test_old');
      expect(t.err).toEqual(['Notice: read REFERALLY_API_KEY as REFERALLI_API_KEY, REFERALLY_API_URL as REFERALLI_API_URL; rename it (no removal date set).']);
      expect(t.out.join('\n')).not.toContain('REFERALLY_');
    });

    it('the new name wins, with no notice', async () => {
      const a = org();
      const t = io({ ...tempEnv(), REFERALLI_API_KEY: 'rk_test_new', REFERALLY_API_KEY: 'rk_test_old', REFERALLI_API_URL: 'http://api.test' }, a.fetchFn);
      expect(await runCli(['whoami'], t.io)).toBe(0);
      expect(a.calls[0]!.headers.authorization).toBe('Bearer rk_test_new');
      expect(t.err).toEqual([]);
    });
  });

  describe('partners list', () => {
    const env = () => ({ ...tempEnv(), REFERALLI_API_KEY: 'rk_test_1', REFERALLI_API_URL: 'http://api.test' });
    const enrollment = (id: string, partnerId: string, externalRef: string | null) => ({ id, partnerId, partnerEmail: `${partnerId}@x.test`, partnerName: partnerId, externalRef, status: 'approved', createdAt: '2026-11-01T00:00:00.000Z' });

    it('pages through everything; the externalRef is the enrollment\'s, else the partner\'s', async () => {
      const a = fakeApi({
        'GET /v1/programs/prg_1/enrollments': (_b, url) =>
          url.includes('starting_after=enr_1')
            ? { object: 'list', data: [enrollment('enr_2', 'ptr_2', null)], has_more: false }
            : { object: 'list', data: [enrollment('enr_1', 'ptr_1', 'own_1')], has_more: true },
        'GET /v1/partners': () => ({ object: 'list', data: [{ id: 'ptr_1', externalRef: 'own_1', status: 'active' }, { id: 'ptr_2', externalRef: 'user_2', status: 'suspended' }], has_more: false }),
      });
      const t = io(env(), a.fetchFn);
      expect(await runCli(['partners', 'list', '--program', 'prg_1', '--json'], t.io)).toBe(0);
      expect(JSON.parse(t.out.join('\n'))).toEqual([
        { partnerId: 'ptr_1', externalRef: 'own_1', email: 'ptr_1@x.test', name: 'ptr_1', status: 'active', enrolledAt: '2026-11-01T00:00:00.000Z' },
        { partnerId: 'ptr_2', externalRef: 'user_2', email: 'ptr_2@x.test', name: 'ptr_2', status: 'suspended', enrolledAt: '2026-11-01T00:00:00.000Z' },
      ]);
      const first = new URL(a.calls.find((c) => c.url.includes('/enrollments'))!.url);
      expect(first.searchParams.get('status')).toBe('approved');
      expect(first.searchParams.has('created[gte]')).toBe(false);
      expect(a.calls.every((c) => c.headers['referalli-version'] === '2026-11-01')).toBe(true);
    });

    it('--since goes to the API as created[gte]; lines show a dash for no externalRef', async () => {
      const a = fakeApi({
        'GET /v1/programs/prg_1/enrollments': () => ({ object: 'list', data: [enrollment('enr_1', 'ptr_1', null)], has_more: false }),
        'GET /v1/partners': () => ({ object: 'list', data: [{ id: 'ptr_1', externalRef: null, status: 'active' }], has_more: false }),
      });
      const t = io(env(), a.fetchFn);
      expect(await runCli(['partners', 'list', '--program', 'prg_1', '--since', '2026-10-01T00:00:00Z'], t.io)).toBe(0);
      expect(new URL(a.calls.find((c) => c.url.includes('/enrollments'))!.url).searchParams.get('created[gte]')).toBe('2026-10-01T00:00:00.000Z');
      expect(t.out).toEqual(['ptr_1  -  ptr_1@x.test  active  enrolled 2026-11-01T00:00:00.000Z']);
    });

    it('--program is required', async () => {
      const t = io(env(), fakeApi({}).fetchFn);
      expect(await runCli(['partners', 'list'], t.io)).toBe(1);
      expect(t.err.join('\n')).toContain('Usage: referalli partners list');
    });
  });
});
