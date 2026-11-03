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
      message: `the key is limited to programs ${k.programIds.join(', ')}: other programs and org-wide setup aren't visible to it`,
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

interface AuthConnection { id: string; provider: string; name: string | null; status: string; tokenVerification: unknown; allowedOrigins: string[] }

async function authChecks(client: Client): Promise<Check[]> {
  const conns = rows(await client.request<AuthConnection[] | { data: AuthConnection[] }>('GET', '/v1/auth/connections'));
  if (conns.length === 0) return [{ id: 'auth', status: 'ok', message: 'no auth connections' }];
  // Protocol connections (Atlas, custom) can't be pinged with an API key: status and settings only.
  return conns.map((c): Check => {
    const id = `auth.${c.id}`;
    const label = `${c.provider} auth connection${c.name ? ` "${c.name}"` : ''}`;
    if (c.status === 'paused') return { id, status: 'warn', message: `${label} is paused`, fix: `PATCH /v1/auth/connections/${c.id} {"status":"active"}` };
    if (c.tokenVerification && c.allowedOrigins.length === 0) {
      return { id, status: 'warn', message: `${label} verifies tokens but has no allowedOrigins: the widget session refuses browsers`, fix: `PATCH /v1/auth/connections/${c.id} {"allowedOrigins":["https://your.app"]}` };
    }
    return { id, status: 'ok', message: `${label} is ${c.status}` };
  });
}

async function trackingCheck(client: Client): Promise<Check[]> {
  const org = await client.request<{ trackingToken: string }>('GET', '/v1/org');
  try {
    const cfg = await client.request<{ cookieWindowDays: number }>('GET', `/t/${encodeURIComponent(org.trackingToken)}/config.json`);
    return [{ id: 'tracking', status: 'ok', message: `tracking token ${org.trackingToken} answers; cookie window ${cfg.cookieWindowDays} days` }];
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    return [{ id: 'tracking', status: 'fail', message: `tracking token ${org.trackingToken} is unknown to /t/…/config.json`, fix: '/settings' }];
  }
}

const MARK = { ok: '✓', warn: '⚠', fail: '✗' } as const;

/** `referalli doctor [--program <id>] [--json]`: read-only health checks. Exit 1 when any check fails. */
export async function runDoctor(io: Io, client: Client, flags: Flags, now = new Date()): Promise<number> {
  const program = typeof flags.program === 'string' ? flags.program : undefined;
  const checks = (
    await Promise.all([
      guard('key', 'referalli login', () => keyCheck(client, now)),
      guard('programs', undefined, () => termsChecks(client, program)),
      guard('webhooks', undefined, () => webhookChecks(client)),
      guard('billing', undefined, () => billingChecks(client)),
      guard('auth', undefined, () => authChecks(client)),
      guard('tracking', undefined, () => trackingCheck(client)),
    ])
  ).flat();
  if (flags.json) io.out(JSON.stringify({ checks }, null, 2));
  else {
    for (const c of checks) {
      io.out(`${MARK[c.status]} ${c.id}: ${c.message}`);
      if (c.fix && c.status !== 'ok') io.out(`    fix: ${c.fix}`);
    }
  }
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
