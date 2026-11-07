import { ApiError, type Client } from './client.js';
import type { Flags, Io } from './commands.js';

/** One line of `referalli doctor`. */
export interface Check {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

const DAY = 86_400_000;
const reason = (err: unknown) =>
  err instanceof ApiError ? `${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}` : (err as Error).message;
// Lists come back as arrays, or `{ data }` on paginated versions.
const rows = <T>(res: T[] | { data: T[] }): T[] => (Array.isArray(res) ? res : res.data);

/** A failed API call is a warning for that check only, never a crash. */
async function guard(id: string, fix: string | undefined, fn: () => Promise<Check[]>): Promise<Check[]> {
  try {
    return await fn();
  } catch (err) {
    return [{ id, status: 'warn', message: `couldn't check: ${reason(err)}`, ...(fix ? { fix } : {}) }];
  }
}

interface Me {
  apiKey: { name: string; scopes: string[]; livemode: boolean; expiresAt: string | null; programIds: string[] | null } | null;
}

async function keyCheck(client: Client, now: Date): Promise<Check[]> {
  let me: Me;
  try {
    me = await client.request<Me>('GET', '/v1/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return [{ id: 'key', status: 'fail', message: `the API key was refused: ${err.message}`, fix: 'referalli login' }];
    }
    throw err;
  }
  const k = me.apiKey;
  if (!k) return [{ id: 'key', status: 'warn', message: 'signed in without an API key; key checks skipped', fix: 'referalli login' }];
  const out: Check[] = [
    { id: 'key', status: 'ok', message: `${k.livemode ? 'live' : 'test'} key "${k.name}", scopes: ${k.scopes.join(', ') || 'none'}` },
  ];
  if (k.expiresAt && new Date(k.expiresAt).getTime() - now.getTime() < 14 * DAY) {
    out.push({ id: 'key.expiry', status: 'warn', message: `the key expires ${k.expiresAt}`, fix: 'referalli keys create --name NAME (then referalli login --key …)' });
  }
  if (k.programIds) {
    out.push({
      id: 'key.programs',
      status: 'warn',
      message: `the key is limited to programs ${k.programIds.join(', ')}: webhook and billing checks see only these programs, and org-wide checks are skipped (listed below)`,
      fix: 'run doctor with an org-wide key to check everything',
    });
  }
  return out;
}

interface Program { id: string; name: string; status: string }

async function termsChecks(client: Client, programId: string | undefined): Promise<Check[]> {
  const programs = programId
    ? [await client.request<Program>('GET', `/v1/programs/${encodeURIComponent(programId)}`)]
    : rows(await client.request<Program[] | { data: Program[] }>('GET', '/v1/programs')).filter((p) => p.status === 'active');
  if (programs.length === 0) return [{ id: 'programs', status: 'warn', message: 'no active programs', fix: '/programs' }];
  return Promise.all(
    programs.map((p) =>
      guard(`program.${p.id}.terms`, undefined, async () => {
        try {
          await client.request('GET', `/v1/programs/${encodeURIComponent(p.id)}/terms`);
          return [{ id: `program.${p.id}.terms`, status: 'ok', message: `program "${p.name}" has a commission rule` }];
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
          return [{ id: `program.${p.id}.terms`, status: 'fail', message: `program "${p.name}" has no commission rule: nothing earns commission`, fix: `POST /v1/commission-rules with programId ${p.id}` }];
        }
      }),
    ),
  ).then((all) => all.flat());
}

interface Endpoint { id: string; url: string; status: string; health: string; consecutiveFailures: number; lastFailure: { statusCode: number | null; error: string | null } | null }

async function webhookChecks(client: Client): Promise<Check[]> {
  const endpoints = rows(await client.request<Endpoint[] | { data: Endpoint[] }>('GET', '/v1/webhook-endpoints'));
  if (endpoints.length === 0) return [{ id: 'webhooks', status: 'ok', message: 'no webhook endpoints' }];
  return endpoints.map((e): Check => {
    const id = `webhook.${e.id}`;
    if (e.health === 'healthy') return { id, status: 'ok', message: `${e.url} is healthy` };
    const last = e.lastFailure ? ` (last: ${e.lastFailure.statusCode ?? e.lastFailure.error ?? 'error'})` : '';
    const why = e.health === 'failing' ? `failing, ${e.consecutiveFailures} failures in a row${last}` : e.health;
    const fix = e.health === 'failing' ? `GET /v1/webhook-endpoints/${e.id}/deliveries` : `PATCH /v1/webhook-endpoints/${e.id} {"status":"active"}`;
    return { id, status: 'warn', message: `${e.url} is ${why}`, fix };
  });
}

interface BillingConnection { id: string; provider: string; name: string; status: string }

async function billingChecks(client: Client): Promise<Check[]> {
  const conns = rows(await client.request<BillingConnection[] | { data: BillingConnection[] }>('GET', '/v1/billing/connections'));
  if (conns.length === 0) {
    return [{ id: 'billing', status: 'warn', message: "no billing connection: payments won't earn commission", fix: 'POST /v1/billing/connections' }];
  }
  return conns.map((c): Check => {
    const id = `billing.${c.id}`;
    const label = `${c.provider} connection "${c.name}"`;
    if (c.status === 'awaiting_secret') {
      return { id, status: 'fail', message: `${label}: provider secret not set, every event is refused`, fix: `PUT /v1/billing/connections/${c.id}/secret {"webhookSecret":"…"}` };
    }
    if (c.status === 'paused') return { id, status: 'warn', message: `${label} is paused`, fix: `PATCH /v1/billing/connections/${c.id} {"status":"active"}` };
    return { id, status: 'ok', message: `${label} is ${c.status}` };
  });
}

interface AuthConnection { id: string; provider: string; name: string | null; status: string; tokenVerification: unknown; allowedOrigins: string[]; lastSignupAt?: string | null; lastError?: { at: string; code: string; message: string } | null }

async function authChecks(client: Client, now: Date): Promise<Check[]> {
  const conns = rows(await client.request<AuthConnection[] | { data: AuthConnection[] }>('GET', '/v1/auth/connections'));
  const out = conns.map((c): Check => {
    const id = `auth.${c.id}`;
    const label = `${c.provider} auth connection${c.name ? ` "${c.name}"` : ''}`;
    if (c.status === 'paused') return { id, status: 'warn', message: `${label} is paused`, fix: `PATCH /v1/auth/connections/${c.id} {"status":"active"}` };
    if (c.tokenVerification && c.allowedOrigins.length === 0) {
      return { id, status: 'warn', message: `${label} verifies tokens but has no allowedOrigins: the widget session refuses browsers`, fix: `PATCH /v1/auth/connections/${c.id} {"allowedOrigins":["https://your.app"]}` };
    }
    // A refusal newer than the last sign-up: the platform is calling, and its calls are failing.
    if (c.lastError && (!c.lastSignupAt || new Date(c.lastError.at) > new Date(c.lastSignupAt))) {
      return { id, status: 'fail', message: `${label} refused its last call (${c.lastError.at}): ${c.lastError.code}: ${c.lastError.message}`, fix: `fix the caller's request body, then retry its failed calls (Atlas: POST /v1/instance/referrals/calls/retry_failed)` };
    }
    // Protocol connections (Atlas, custom) can't be pinged with an API key: when it last filed a sign-up says it's wired.
    // undefined: an API from before lastSignupAt, nothing to say.
    if (c.lastSignupAt === null) {
      return { id, status: 'warn', message: `${label} is ${c.status} but has never filed a sign-up`, fix: `sign up a user in your app (test sign-ups don't count) and check the platform calls connection ${c.id}` };
    }
    if (c.lastSignupAt && now.getTime() - new Date(c.lastSignupAt).getTime() > 30 * DAY) {
      return { id, status: 'warn', message: `${label} is ${c.status}; no sign-up since ${c.lastSignupAt}`, fix: `check the platform still calls connection ${c.id}` };
    }
    return { id, status: 'ok', message: `${label} is ${c.status}${c.lastSignupAt ? `; last sign-up ${c.lastSignupAt}` : ''}` };
  });
  if (!conns.some((c) => c.provider === 'atlas')) {
    const other = conns.find((c) => c.status === 'active');
    out.push(
      other
        ? { id: 'auth.atlas', status: 'ok', message: `no Atlas connection; sign-ups come through ${other.provider}` }
        : { id: 'auth.atlas', status: 'warn', message: 'no Atlas connection (and no other active auth connection): sign-ups are attributed only if your app calls associate', fix: 'POST /v1/auth/connections {"provider":"atlas","programId":"prg_…","instanceId":"…"}' },
    );
  }
  return out;
}

type Mode = 'live' | 'test';
interface TrackingTokens { mode: Mode; live: { trackingToken: string }; test: { trackingToken: string } }

async function trackingCheck(client: Client, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const org = await client.request<{ trackingToken: string; livemode?: boolean }>('GET', '/v1/org');
  const out: Check[] = [];
  try {
    const cfg = await client.request<{ cookieWindowDays: number }>('GET', `/t/${encodeURIComponent(org.trackingToken)}/config.json`);
    out.push({ id: 'tracking', status: 'ok', message: `tracking token ${org.trackingToken} answers; cookie window ${cfg.cookieWindowDays} days` });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    out.push({ id: 'tracking', status: 'fail', message: `tracking token ${org.trackingToken} is unknown to /t/…/config.json`, fix: '/settings' });
  }
  // Consent mode `none` (orgs from before consent support start there): aff.js stores the referral before the visitor chooses.
  if (org.livemode !== false) {
    out.push(
      ...(await guard('tracking.consent', '/settings → Install', async () => {
        const c = await client.request<{ mode: string }>('GET', '/v1/org/tracking-consent');
        return c.mode === 'none'
          ? [{ id: 'tracking.consent', status: 'warn' as const, message: "tracking consent is 'none': aff.js stores the referral before the visitor chooses", fix: `PUT /v1/org/tracking-consent {"mode":"auto"} (or /settings → Install)` }]
          : [{ id: 'tracking.consent', status: 'ok' as const, message: `tracking consent: ${c.mode}` }];
      })),
    );
  }
  // The token the product is configured with (run doctor with the app's env) must be this mode's.
  const name = env.REFERALLI_TRACKING_TOKEN ? 'REFERALLI_TRACKING_TOKEN' : env.NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN ? 'NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN' : null;
  if (!name) return out;
  const configured = env[name]!.trim();
  const mode: Mode = org.livemode === false ? 'test' : 'live';
  const id = 'tracking.configured';
  const fix = `referalli env pull --mode ${mode}`;
  if (configured === org.trackingToken) {
    out.push({ id, status: 'ok', message: `${name} is the org's ${mode} token` });
    return out;
  }
  const other: Mode = mode === 'live' ? 'test' : 'live';
  const tokens = await guard(id, fix, async () => {
    const t = await client.request<TrackingTokens>('GET', '/v1/org/tracking-tokens');
    if (t[other].trackingToken === configured) {
      return [{ id, status: 'warn', message: `${name} is the org's ${other} token but this key is ${mode}: run doctor with a ${other} key, or switch the app to the ${mode} token`, fix }];
    }
    return [{ id, status: 'fail', message: `${name}=${configured} is neither the org's live nor its test token: aff.js and links won't attribute to this org`, fix }];
  });
  return [...out, ...tokens];
}

const MARK = { ok: '✓', warn: '⚠', fail: '✗' } as const;

export function printChecks(out: (line: string) => void, checks: Check[], json: unknown): void {
  if (json) {
    out(JSON.stringify({ checks }, null, 2));
    return;
  }
  for (const c of checks) {
    out(`${MARK[c.status]} ${c.id}: ${c.message}`);
    if (c.fix && c.status !== 'ok') out(`    fix: ${c.fix}`);
  }
}

// What a program-scoped key is refused (the API's programScopedAllows), and the scope an org-wide key needs instead.
const ORG_WIDE = {
  auth: { what: 'auth connections, Atlas sign-ups', scope: 'integrations:read or connections:read' },
  tracking: { what: 'tracking token, consent mode, configured token', scope: 'org:read' },
} as const;

interface E2eLink { code: string; destinationUrl: string | null }
const OUTSIDE = { method: 'GET', headers: { 'user-agent': 'referalli-doctor-bot' } };

/** One program from outside, as a visitor would meet it. Runs here, not on the API, so it can't be aimed at our own network. */
async function e2eChecks(client: Client, programId: string, fetchFn: typeof fetch, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const out: Check[] = [];
  const get = (url: string, redirect: 'follow' | 'manual' = 'follow') => fetchFn(url, { ...OUTSIDE, redirect, signal: AbortSignal.timeout(10_000) });
  const me = await client.request<Me>('GET', '/v1/me');
  // A program-scoped key can't read the org; the token is public (it's in every page's script tag), so the env can supply it.
  const trackingToken = await client
    .request<{ trackingToken: string }>('GET', '/v1/org')
    .then((o) => o.trackingToken)
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 403) return env.REFERALLI_TRACKING_TOKEN ?? env.NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN;
      throw err;
    });
  if (!trackingToken) {
    return [{ id: 'e2e', status: 'warn', message: "skipped: this key can't read the org's tracking token", fix: 'set REFERALLI_TRACKING_TOKEN and run again' }];
  }
  const live = me.apiKey?.livemode !== false;
  const scriptPath = `/t/${encodeURIComponent(trackingToken)}/aff.js`;

  const script = await get(`${client.baseUrl}${scriptPath}`).catch((err: Error) => err);
  out.push(
    script instanceof Response && script.ok
      ? { id: 'e2e.script', status: 'ok', message: 'aff.js loads' }
      : { id: 'e2e.script', status: 'fail', message: `aff.js didn't load: ${script instanceof Response ? script.status : script.message}` },
  );

  const links = rows(await client.request<E2eLink[] | { data: E2eLink[] }>('GET', `/v1/links?programId=${encodeURIComponent(programId)}&limit=20`));
  type Conn = { programId: string; destinationUrl?: string | null };
  // A key without connections:read can still test its links.
  const conns = await client.request<Conn[] | { data: Conn[] }>('GET', '/v1/auth/connections').then(rows, (): Conn[] => []);
  const link = links.find((l) => l.destinationUrl);
  const destinations = [
    ...new Set(
      [...conns.filter((c) => c.programId === programId).map((c) => c.destinationUrl), link?.destinationUrl]
        .filter((d): d is string => !!d)
        .map((d) => d.replaceAll('{code}', link?.code ?? 'doctor').replaceAll('%7Bcode%7D', link?.code ?? 'doctor')),
    ),
  ];
  if (destinations.length === 0) out.push({ id: 'e2e.destination', status: 'warn', message: 'no destination to test: no link or auth connection in this program has one' });
  for (const url of destinations) {
    const res = await get(url).catch((err: Error) => err);
    if (!(res instanceof Response) || !res.ok) {
      out.push({ id: 'e2e.destination', status: 'fail', message: `${url} didn't answer 200: ${res instanceof Response ? res.status : res.message}`, fix: 'update destinationUrl on the link or auth connection' });
      continue;
    }
    out.push({ id: 'e2e.destination', status: 'ok', message: `${url} answers ${res.status}` });
    const html = await res.text();
    out.push(
      html.includes(scriptPath)
        ? { id: 'e2e.landing', status: 'ok', message: `${url} includes aff.js with this org's token` }
        : { id: 'e2e.landing', status: 'warn', message: `${url} doesn't include aff.js with this org's token in its HTML (a tag manager would load it later)`, fix: '/settings → Install' },
    );
  }

  if (!link) {
    out.push({ id: 'e2e.go', status: 'warn', message: 'no partner link to test in this program' });
  } else {
    const res = await get(`${client.baseUrl}/go/${encodeURIComponent(trackingToken)}/${encodeURIComponent(link.code)}`, 'manual').catch((err: Error) => err);
    const to = res instanceof Response ? res.headers.get('location') : null;
    out.push(
      to?.includes(`via=${encodeURIComponent(link.code)}`)
        ? { id: 'e2e.go', status: 'ok', message: `/go/…/${link.code} redirects with the code` }
        : { id: 'e2e.go', status: 'fail', message: `/go/…/${link.code} didn't redirect with its code: ${res instanceof Response ? res.status : res.message}` },
    );
  }
  out.push({ id: 'e2e.cookie', status: 'warn', message: 'not checked: aff.js sets the cookie in a browser', fix: 'open a /go link in a browser and look for the referral cookie' });

  if (live) {
    out.push({ id: 'e2e.conversion', status: 'warn', message: 'skipped with a live key, so it never earns real commissions', fix: 'run again with a test key and a test-mode program' });
  } else if (!link) {
    out.push({ id: 'e2e.conversion', status: 'warn', message: 'skipped: it needs a partner link in this program' });
  } else {
    try {
      await client.request('POST', '/v1/sandbox/simulate', { scenario: 'signup_and_pay', programId, code: link.code });
      out.push({ id: 'e2e.conversion', status: 'ok', message: 'test sign-up and payment recorded' });
    } catch (err) {
      out.push({ id: 'e2e.conversion', status: 'fail', message: `test sign-up and payment failed: ${reason(err)}` });
    }
  }
  return out;
}

/** `referalli doctor [--program <id>] [--json]`: read-only health checks, plus `--e2e`. Exit 1 when any check fails. */
export async function runDoctor(io: Io, client: Client, flags: Flags, now = new Date()): Promise<number> {
  const program = typeof flags.program === 'string' ? flags.program : undefined;
  const key = await guard('key', 'referalli login', () => keyCheck(client, now));
  const scoped = key.some((c) => c.id === 'key.programs');
  // Asks the API rather than copying its allowlist: if it opens one of these to scoped keys, the check just runs.
  const orgWide = (id: keyof typeof ORG_WIDE, fn: () => Promise<Check[]>) =>
    guard(id, undefined, async () => {
      try {
        return await fn();
      } catch (err) {
        if (!scoped || !(err instanceof ApiError) || err.status !== 403) throw err;
        const { what, scope } = ORG_WIDE[id];
        return [{ id, status: 'warn', message: `skipped, this program-scoped key can't read it (${what})`, fix: `run doctor with an org-wide key (no programs) with ${scope}; read or full also work` }];
      }
    });
  const checks = [
    ...key,
    ...(
      await Promise.all([
        guard('programs', undefined, () => termsChecks(client, program)),
        guard('webhooks', undefined, () => webhookChecks(client)),
        guard('billing', undefined, () => billingChecks(client)),
        orgWide('auth', () => authChecks(client, now)),
        orgWide('tracking', () => trackingCheck(client, io.env)),
        ...(flags.e2e && program ? [guard('e2e', undefined, () => e2eChecks(client, program, io.fetchFn ?? fetch, io.env))] : []),
      ])
    ).flat(),
  ];
  printChecks((l) => io.out(l), checks, flags.json);
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
