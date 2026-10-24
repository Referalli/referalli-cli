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
});
