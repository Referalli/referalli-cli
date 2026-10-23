import { hostname } from 'node:os';
import { ApiError, createClient, type Client, type FetchFn } from './client.js';
import { DEFAULT_BASE_URL, readConfig, removeConfig, writeConfig, type CliConfig } from './config.js';

/** Everything a command touches, injected so commands are testable. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  fetchFn?: FetchFn;
  sleep(ms: number): Promise<void>;
  /** Try to open a URL in the browser; false when it couldn't. */
  openBrowser(url: string): boolean;
  /** Aborted on Ctrl-C: long-running commands stop and clean up. */
  signal: AbortSignal;
}

export type Flags = Record<string, string | boolean>;

/** A user-facing failure: printed without a stack trace, exit code 1. */
export class CliError extends Error {}

function signedIn(io: Io): { config: CliConfig; client: Client } {
  const config = readConfig(io.env);
  if (!config) throw new CliError('Not signed in. Run `referalli login` first (or set REFERALLI_API_KEY).');
  return { config, client: createClient({ baseUrl: config.baseUrl, key: config.key, fetchFn: io.fetchFn }) };
}

const time = (d: Date | string) => new Date(d).toISOString().slice(11, 19);

// --- login / logout / whoami ---------------------------------------------------

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}
type TokenResult =
  | { status: 'pending' | 'denied' | 'expired' | 'consumed' }
  | { status: 'approved'; key: string; orgId: string; orgName: string; scopes: string[] };

export async function login(io: Io, flags: Flags): Promise<number> {
  const baseUrl = String(flags['base-url'] ?? io.env.REFERALLI_API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  if (typeof flags.key === 'string') {
    // Non-interactive: check the pasted key works before saving it.
    const client = createClient({ baseUrl, key: flags.key, fetchFn: io.fetchFn });
    const org = await client.request<{ id: string; name: string }>('GET', '/v1/org');
    const path = writeConfig({ baseUrl, key: flags.key, orgId: org.id, orgName: org.name }, io.env);
    io.out(`Signed in to ${org.name} (${org.id}). Key saved to ${path}.`);
    return 0;
  }
  const client = createClient({ baseUrl, fetchFn: io.fetchFn });
  const code = await client.request<DeviceCode>('POST', '/v1/cli/device-codes', { clientName: hostname().slice(0, 80) });
  io.out(`Your sign-in code is ${code.userCode}.`);
  io.out(`Confirm it at ${code.verificationUriComplete}`);
  if (!flags['no-browser'] && io.openBrowser(code.verificationUriComplete)) io.out('(opened in your browser)');
  io.out('Waiting for approval…');
  const deadline = Date.now() + code.expiresIn * 1000;
  let interval = code.interval * 1000;
  while (Date.now() < deadline && !io.signal.aborted) {
    await io.sleep(interval);
    let result: TokenResult;
    try {
      result = await client.request<TokenResult>('POST', '/v1/cli/device-codes/token', { deviceCode: code.deviceCode });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        interval += 1000; // asked to slow down
        continue;
      }
      throw err;
    }
    if (result.status === 'approved') {
      const path = writeConfig({ baseUrl, key: result.key, orgId: result.orgId, orgName: result.orgName }, io.env);
      io.out(`Signed in to ${result.orgName} (${result.orgId}) with access: ${result.scopes.join(', ')}.`);
      io.out(`Key saved to ${path}.`);
      return 0;
    }
    if (result.status === 'denied') throw new CliError('The sign-in was denied.');
    if (result.status === 'expired' || result.status === 'consumed') break;
  }
  throw new CliError('The sign-in code expired. Run `referalli login` again.');
}

export async function logout(io: Io): Promise<number> {
  io.out(removeConfig(io.env) ? 'Signed out; the saved key was removed. Revoke it under Settings → API keys if it may have leaked.' : 'Not signed in.');
  return 0;
}

export async function whoami(io: Io): Promise<number> {
  const { config, client } = signedIn(io);
  const org = await client.request<{ id: string; name: string }>('GET', '/v1/org');
  io.out(`${org.name} (${org.id})`);
  io.out(`API: ${config.baseUrl}`);
  io.out(`Key: ${config.key.slice(0, 12)}…`);
  return 0;
}

// --- listen ----------------------------------------------------------------------

interface ListenerEvent {
  id: string;
  eventId: string;
  topic: string;
  body: string;
  headers: Record<string, string>;
}

export async function listen(io: Io, flags: Flags): Promise<number> {
  const { client } = signedIn(io);
  const forwardTo = typeof flags['forward-to'] === 'string' ? flags['forward-to'] : null;
  const topics = typeof flags.events === 'string' ? flags.events.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const maxEvents = typeof flags['max-events'] === 'string' ? Number(flags['max-events']) : Infinity;
  const wait = typeof flags.wait === 'string' ? Number(flags.wait) : 20;
  const fetchFn = io.fetchFn ?? fetch;
  const listener = await client.request<{ id: string; secret: string; topics: string[] }>('POST', '/v1/cli/listeners', {
    ...(topics ? { topics } : {}),
    ...(forwardTo ? { forwardTo } : {}),
  });
  io.out(`Ready! Listening for ${listener.topics.join(', ')}${forwardTo ? ` and forwarding to ${forwardTo}` : ''}.`);
  io.out(`Your webhook signing secret is ${listener.secret} (verify deliveries with it while testing).`);
  let seen = 0;
  try {
    while (!io.signal.aborted && seen < maxEvents) {
      let batch: ListenerEvent[];
      try {
        batch = (
          await client.request<{ events: ListenerEvent[] }>(
            'GET',
            `/v1/cli/listeners/${listener.id}/events?wait=${wait}`,
            undefined,
            { signal: io.signal },
          )
        ).events;
      } catch (err) {
        if (io.signal.aborted) break;
        io.err(`Polling failed (${(err as Error).message}); retrying…`);
        await io.sleep(2000);
        continue;
      }
      for (const e of batch) {
        seen++;
        if (!forwardTo) {
          io.out(`${time(new Date())}  ${e.topic}  [${e.eventId}]`);
          io.out(e.body);
        } else {
          const started = Date.now();
          try {
            const res = await fetchFn(forwardTo, { method: 'POST', headers: e.headers, body: e.body });
            io.out(`${time(new Date())}  --> ${e.topic} [${e.eventId}]  <-- ${res.status} (${Date.now() - started}ms)`);
          } catch (err) {
            io.err(`${time(new Date())}  --> ${e.topic} [${e.eventId}]  failed: ${(err as Error).message}`);
          }
        }
        if (seen >= maxEvents) break;
      }
    }
  } finally {
    await client.request('DELETE', `/v1/cli/listeners/${listener.id}`).catch(() => {});
  }
  return 0;
}

// --- events tail -----------------------------------------------------------------

/**
 * `referalli events tail`: print every event your account emits, live, one line each
 * (or the full Standard Webhooks body with --json). It opens a CLI listener like
 * `listen` does, without forwarding, and closes it on exit.
 */
export async function eventsTail(io: Io, flags: Flags): Promise<number> {
  const { client } = signedIn(io);
  const topics = typeof flags.events === 'string' ? flags.events.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const max = typeof flags.max === 'string' ? Number(flags.max) : Infinity;
  const wait = typeof flags.wait === 'string' ? Number(flags.wait) : 20;
  const listener = await client.request<{ id: string; topics: string[] }>('POST', '/v1/cli/listeners', topics ? { topics } : {});
  if (!flags.json) io.err(`Tailing ${listener.topics.join(', ')} (Ctrl-C to stop)…`);
  let seen = 0;
  try {
    while (!io.signal.aborted && seen < max) {
      let batch: ListenerEvent[];
      try {
        batch = (
          await client.request<{ events: ListenerEvent[] }>('GET', `/v1/cli/listeners/${listener.id}/events?wait=${wait}`, undefined, {
            signal: io.signal,
          })
        ).events;
      } catch (err) {
        if (io.signal.aborted) break;
        io.err(`Polling failed (${(err as Error).message}); retrying…`);
        await io.sleep(2000);
        continue;
      }
      for (const e of batch) {
        seen++;
        if (flags.json) io.out(e.body);
        else io.out(`${time(new Date())}  ${e.topic.padEnd(24)} ${e.eventId}${summarize(e.body)}`);
        if (seen >= max) break;
      }
    }
  } finally {
    await client.request('DELETE', `/v1/cli/listeners/${listener.id}`).catch(() => {});
  }
  return 0;
}

/** A short "key=value" tail for an event line: the ids and amounts a developer looks for. */
function summarize(body: string): string {
  try {
    const data = (JSON.parse(body) as { data?: Record<string, unknown> }).data ?? {};
    const keys = ['partnerId', 'referralId', 'commissionId', 'payoutId', 'amountMinor', 'currency', 'status'];
    const parts = keys.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => `${k}=${String(data[k])}`);
    return parts.length ? `  ${parts.join(' ')}` : '';
  } catch {
    return '';
  }
}

// --- open --------------------------------------------------------------------------

export const OPEN_TARGETS: Record<string, string> = {
  docs: '/docs',
  dashboard: '/dashboard',
  keys: '/settings',
  webhooks: '/webhooks',
  spec: '/v1/openapi.json',
  status: '/status',
};

/** `referalli open [docs|dashboard|keys|webhooks|spec|status]`: open the page, or print it. */
export async function open(io: Io, target: string | undefined, flags: Flags): Promise<number> {
  const name = target ?? 'docs';
  const path = OPEN_TARGETS[name];
  if (!path) throw new CliError(`Usage: referalli open [${Object.keys(OPEN_TARGETS).join('|')}]`);
  const config = readConfig(io.env);
  const base = String(flags['base-url'] ?? config?.baseUrl ?? io.env.REFERALLI_API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${base}${path}`;
  io.out(io.openBrowser(url) ? `Opened ${url}` : url);
  return 0;
}

// --- trigger -----------------------------------------------------------------------

export async function trigger(io: Io, topic: string | undefined, flags: Flags): Promise<number> {
  const { client } = signedIn(io);
  if (!topic) {
    const { topics } = await client.request<{ topics: string[] }>('GET', '/v1/cli/topics');
    throw new CliError(`Usage: referalli trigger <topic>. Topics: ${topics.join(', ')}`);
  }
  let data: Record<string, unknown> | undefined;
  if (typeof flags.data === 'string') {
    try {
      data = JSON.parse(flags.data) as Record<string, unknown>;
    } catch {
      throw new CliError('--data must be a JSON object, e.g. --data \'{"amountMinor": 2500}\'');
    }
  }
  const res = await client.request<{ eventId: string; deliveredTo: { listeners: number; endpoints: number } }>(
    'POST',
    '/v1/cli/trigger',
    { topic, ...(data ? { data } : {}) },
  );
  io.out(`Triggered ${topic} [${res.eventId}]: ${res.deliveredTo.listeners} listener(s), ${res.deliveredTo.endpoints} webhook endpoint(s).`);
  return 0;
}

// --- logs tail ---------------------------------------------------------------------

interface LogEntry {
  seq: number;
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  ts: string;
}

const logLine = (e: LogEntry) =>
  `${time(e.ts)}  ${e.method.padEnd(6)} ${e.path}  ${e.status}  ${e.latencyMs}ms  ${e.requestId}`;

export async function logsTail(io: Io, flags: Flags): Promise<number> {
  const { client } = signedIn(io);
  const max = typeof flags.max === 'string' ? Number(flags.max) : Infinity;
  const wait = typeof flags.wait === 'string' ? Number(flags.wait) : 20;
  let printed = 0;
  const first = await client.request<{ entries: LogEntry[]; cursor: number }>('GET', '/v1/cli/logs');
  for (const e of first.entries) {
    io.out(logLine(e));
    if (++printed >= max) return 0;
  }
  let cursor = first.cursor;
  while (!io.signal.aborted && printed < max) {
    let page: { entries: LogEntry[]; cursor: number };
    try {
      page = await client.request('GET', `/v1/cli/logs?after=${cursor}&wait=${wait}`, undefined, { signal: io.signal });
    } catch (err) {
      if (io.signal.aborted) break;
      io.err(`Polling failed (${(err as Error).message}); retrying…`);
      await io.sleep(2000);
      continue;
    }
    for (const e of page.entries) {
      io.out(logLine(e));
      if (++printed >= max) break;
    }
    cursor = page.cursor;
  }
  return 0;
}

// --- keys --------------------------------------------------------------------------

interface IssuedKey {
  id: string;
  key: string;
  livemode: boolean;
  scopes: string[];
  owner: string | null;
  expiresAt: string | null;
}

interface ListedKey {
  id: string;
  name: string;
  prefix: string;
  livemode: boolean;
  owner: string | null;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  revokedAt: string | null;
}

/**
 * `referalli keys create|list|revoke`: mint a developer their own live and
 * test keys (needs an admin key), list the team's keys, or revoke one.
 */
export async function keys(io: Io, sub: string | undefined, arg: string | undefined, flags: Flags): Promise<number> {
  const { client } = signedIn(io);
  if (sub === 'create') {
    if (typeof flags.name !== 'string') throw new CliError('Usage: referalli keys create --name NAME [--owner WHO] [--mode both|live|test] [--scopes full,…] [--expires-days N]');
    const mode = typeof flags.mode === 'string' ? flags.mode : 'both';
    if (!['both', 'live', 'test'].includes(mode)) throw new CliError('--mode is both, live or test');
    const body: Record<string, unknown> = { name: flags.name, mode };
    if (typeof flags.owner === 'string') body.owner = flags.owner;
    if (typeof flags.scopes === 'string') body.scopes = flags.scopes.split(',').map((x) => x.trim()).filter(Boolean);
    if (typeof flags['expires-days'] === 'string') body.expiresInDays = Number(flags['expires-days']);
    const res = await client.request<IssuedKey | { pairId: string; live: IssuedKey; test: IssuedKey }>('POST', '/v1/api-keys', body);
    const issued = 'live' in res ? [res.live, res.test] : [res];
    io.out('Each key is shown once. Store it now (a password manager or your secrets store):');
    for (const k of issued) io.out(`  ${k.livemode ? 'live' : 'test'}  ${k.key}   (${k.id})`);
    return 0;
  }
  if (sub === 'list') {
    const q = new URLSearchParams();
    if (typeof flags.owner === 'string') q.set('owner', flags.owner);
    if (typeof flags.mode === 'string') q.set('mode', flags.mode);
    const res = await client.request<ListedKey[] | { data: ListedKey[] }>('GET', `/v1/api-keys${String(q) ? `?${q}` : ''}`);
    const rows = Array.isArray(res) ? res : res.data;
    for (const k of rows) {
      const state = k.revokedAt ? 'revoked' : k.expired ? 'expired' : 'active';
      io.out(
        [k.id, k.livemode ? 'live' : 'test', state, `${k.prefix}…`, k.name, k.owner ?? '-', k.scopes.join(','), k.lastUsedAt ? `used ${k.lastUsedAt}` : 'never used']
          .join('  '),
      );
    }
    return 0;
  }
  if (sub === 'revoke') {
    if (!arg) throw new CliError('Usage: referalli keys revoke <key id> [--pair] [--cascade]');
    const q = new URLSearchParams();
    if (flags.pair) q.set('pair', 'true');
    if (flags.cascade) q.set('cascade', 'true');
    const res = await client.request<{ revoked: string[] }>('DELETE', `/v1/api-keys/${encodeURIComponent(arg)}${String(q) ? `?${q}` : ''}`);
    io.out(`Revoked: ${res.revoked.join(', ') || 'nothing (already revoked)'}`);
    return 0;
  }
  throw new CliError('Usage: referalli keys create|list|revoke');
}

// --- api ---------------------------------------------------------------------------

export async function api(io: Io, method: string | undefined, path: string | undefined, flags: Flags): Promise<number> {
  if (!method || !path) throw new CliError('Usage: referalli api <METHOD> <path> [--data JSON]');
  const { client } = signedIn(io);
  let body: unknown;
  if (typeof flags.data === 'string') {
    try {
      body = JSON.parse(flags.data);
    } catch {
      throw new CliError('--data must be JSON');
    }
  }
  const res = await client.request(method.toUpperCase(), path.startsWith('/') ? path : `/${path}`, body);
  io.out(JSON.stringify(res, null, 2));
  return 0;
}
