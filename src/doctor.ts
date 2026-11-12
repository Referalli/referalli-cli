import { listAll } from './apply.js';
import { ApiError, type Client } from './client.js';
import type { Flags, Io } from './commands.js';

/** One line of `referalli doctor`. */
export interface Check {
  id: string;
  /** `info`: worth knowing, never a problem (doctor --scan: a REFERALLY_* name of the app's own). */
  status: 'ok' | 'info' | 'warn' | 'fail';
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
  apiKey: { id?: string; name: string; scopes: string[]; livemode: boolean; expiresAt: string | null; programIds: string[] | null } | null;
}

/** The key's checks, and the key itself for scoping the rest (null when it couldn't be read). */
async function keyCheck(client: Client, now: Date): Promise<{ checks: Check[]; key: Me['apiKey'] }> {
  let me: Me;
  try {
    me = await client.request<Me>('GET', '/v1/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { checks: [{ id: 'key', status: 'fail', message: `the API key was refused: ${err.message}`, fix: 'referalli login' }], key: null };
    }
    return { checks: [{ id: 'key', status: 'warn', message: `couldn't check: ${reason(err)}`, fix: 'referalli login' }], key: null };
  }
  const k = me.apiKey;
  if (!k) return { checks: [{ id: 'key', status: 'warn', message: 'signed in without an API key; key checks skipped', fix: 'referalli login' }], key: null };
  const out: Check[] = [
    { id: 'key', status: 'ok', message: `${k.livemode ? 'live' : 'test'} key "${k.name}", scopes: ${k.scopes.join(', ') || 'none'}` },
  ];
  if (k.expiresAt && new Date(k.expiresAt).getTime() - now.getTime() < 14 * DAY) {
    out.push({ id: 'key.expiry', status: 'warn', message: `the key expires ${k.expiresAt}`, fix: 'referalli keys create --name NAME (then referalli login --key …)' });
  }
  if (k.programIds) {
    // R-08: a scoped key is normal (one org, several products): the checks below cover its programs only.
    out.push({ id: 'key.programs', status: 'ok', message: `the key is limited to programs ${k.programIds.join(', ')}: the checks below cover only these (org-wide ones it can't read say so)` });
  }
  return { checks: out, key: k };
}

interface Program {
  id: string;
  name: string;
  status: string;
  publicHandle?: string | null;
  publicPage?: { autoApprove?: boolean };
  /** The program's own aff.js consent mode; null/absent: the org's. */
  trackingConsent?: string | null;
  /** GET /v1/programs/{id}: what aff.js serves it (its own mode, else the org's). */
  effectiveTrackingConsent?: string;
  settings?: { settlement?: string; widget?: { autoEnroll?: boolean; destinationUrl?: string | null } };
}

/** The programs doctor checks: the scope's (each fetched), else every active one. */
async function loadPrograms(client: Client, scope: string[] | null): Promise<Program[]> {
  return scope
    ? Promise.all(scope.map((id) => client.request<Program>('GET', `/v1/programs/${encodeURIComponent(id)}`)))
    : rows(await client.request<Program[] | { data: Program[] }>('GET', '/v1/programs')).filter((p) => p.status === 'active');
}

/** Outside the scope: limited to programs, none of them in it. Org-wide (null) resources concern every program. */
const outside = (scope: string[] | null, programIds: string[] | null | undefined) =>
  Boolean(scope && programIds && programIds.length > 0 && !programIds.some((id) => scope.includes(id)));

/** RF-1: problems found outside the scope, summed into one info line instead of failing the scoped run. */
interface Tally { other: number }

/**
 * RF-1: a scoped run meets an org-wide resource the scoped programs don't use (each has one of its own):
 * its failure is ⚠ with a note, never ✗.
 */
const unusedOrgWide = (c: Check, note: string): Check =>
  c.status === 'fail' ? { ...c, status: 'warn', message: `${c.message} (org-wide, ${note})` } : c;

async function termsChecks(client: Client, programs: Program[]): Promise<Check[]> {
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

interface Endpoint { id: string; url: string; status: string; health: string; consecutiveFailures: number; lastFailure: { statusCode: number | null; error: string | null } | null; programIds?: string[] | null }

async function webhookChecks(client: Client, scope: string[] | null, tally: Tally): Promise<Check[]> {
  const all = rows(await client.request<Endpoint[] | { data: Endpoint[] }>('GET', '/v1/webhook-endpoints'));
  tally.other += all.filter((e) => outside(scope, e.programIds) && e.health !== 'healthy').length;
  const endpoints = all.filter((e) => !outside(scope, e.programIds));
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

interface BillingConnection { id: string; provider: string; name: string; status: string; programIds?: string[] | null }

function billingChecks(scope: string[] | null, all: BillingConnection[], tally: Tally): Check[] {
  const conns = all.filter((c) => !outside(scope, c.programIds));
  tally.other += all.filter((c) => outside(scope, c.programIds) && billingCheck(c).status !== 'ok').length;
  if (conns.length === 0) {
    return [{ id: 'billing', status: 'warn', message: "no billing connection: payments won't earn commission", fix: 'POST /v1/billing/connections' }];
  }
  // Scoped: a failing org-wide connection fails the run only when the program has nothing else that works
  // (several products often share one org, each with its own org-wide connection).
  const working = conns.filter((c) => billingCheck(c).status !== 'fail').length;
  return conns.map((c) => {
    const check = billingCheck(c);
    if (!scope || c.programIds?.length || working === 0 || check.status !== 'fail') return check;
    const own = all.some((o) => scope.some((p) => o.programIds?.includes(p)));
    const why = own ? 'not used by this program: it has its own billing connection' : 'this program has another working connection';
    return { ...unusedOrgWide(check, why), fix: `if it belongs to other programs, limit it: PATCH /v1/billing/connections/${c.id} {"programIds":["prg_…"]}` };
  });
}

function billingCheck(c: BillingConnection): Check {
  const id = `billing.${c.id}`;
  const label = `${c.provider} connection "${c.name}"`;
  if (c.status === 'awaiting_secret') {
    return { id, status: 'fail', message: `${label}: provider secret not set, every event is refused`, fix: `PUT /v1/billing/connections/${c.id}/secret {"webhookSecret":"…"}` };
  }
  if (c.status === 'paused') return { id, status: 'warn', message: `${label} is paused`, fix: `PATCH /v1/billing/connections/${c.id} {"status":"active"}` };
  return { id, status: 'ok', message: `${label} is ${c.status}` };
}

interface AuthConnection {
  id: string;
  provider: string;
  programId?: string;
  name: string | null;
  status: string;
  tokenVerification: unknown;
  allowedOrigins: string[];
  lastSignupAt?: string | null;
  /** R-30: when Referalli received the last sign-up (lastSignupAt is the sign-up's own time). */
  lastSignupReceivedAt?: string | null;
  lastError?: { at: string; code: string; message: string } | null;
  /** RF-5: the last refused sign-up call. */
  lastRejectedAt?: string | null;
  lastRejectedReason?: string | null;
}

async function authChecks(client: Client, now: Date, programs: Program[], scope: string[] | null, tally: Tally): Promise<Check[]> {
  const all = rows(await client.request<AuthConnection[] | { data: AuthConnection[] }>('GET', '/v1/auth/connections'));
  const isOutside = (c: AuthConnection) => outside(scope, c.programId ? [c.programId] : null);
  const conns = all.filter((c) => !isOutside(c));
  const check = (c: AuthConnection): Check => {
    // Receipt time when the API has it: a late-filed sign-up must not look like a fresh one (R-30).
    const lastSignupAt = c.lastSignupReceivedAt ?? c.lastSignupAt;
    const id = `auth.${c.id}`;
    const label = `${c.provider} auth connection${c.name ? ` "${c.name}"` : ''}`;
    if (c.status === 'paused') return { id, status: 'warn', message: `${label} is paused`, fix: `PATCH /v1/auth/connections/${c.id} {"status":"active"}` };
    if (c.tokenVerification && c.allowedOrigins.length === 0) {
      return { id, status: 'warn', message: `${label} verifies tokens but has no allowedOrigins: the widget session refuses browsers`, fix: `PATCH /v1/auth/connections/${c.id} {"allowedOrigins":["https://your.app"]}` };
    }
    // A refusal newer than the last sign-up: the platform is calling, and its calls are failing.
    if (c.lastError && (!lastSignupAt || new Date(c.lastError.at) > new Date(lastSignupAt))) {
      return { id, status: 'fail', message: `${label} refused its last call (${c.lastError.at}): ${c.lastError.code}: ${c.lastError.message}`, fix: `fix the caller's request body, then retry its failed calls (Atlas: POST /v1/instance/referrals/calls/retry_failed)` };
    }
    // Protocol connections (Atlas, custom) can't be pinged with an API key: when it last filed a sign-up says it's wired.
    // undefined: an API from before lastSignupAt, nothing to say.
    const rejected = c.lastRejectedAt ? `; last refused call ${c.lastRejectedAt}${c.lastRejectedReason ? ` (${c.lastRejectedReason})` : ''}` : '';
    if (lastSignupAt === null) {
      return { id, status: 'warn', message: `${label} is ${c.status} but has never filed a sign-up${rejected}`, fix: `sign up a user in your app (test sign-ups don't count) and check the platform calls connection ${c.id}` };
    }
    if (lastSignupAt && now.getTime() - new Date(lastSignupAt).getTime() > 30 * DAY) {
      return { id, status: 'warn', message: `${label} is ${c.status}; no sign-up since ${lastSignupAt}`, fix: `check the platform still calls connection ${c.id}` };
    }
    return { id, status: 'ok', message: `${label} is ${c.status}${lastSignupAt ? `; last sign-up ${lastSignupAt}` : ''}${rejected}` };
  };
  tally.other += all.filter((c) => isOutside(c) && check(c).status !== 'ok').length;
  const usesOrgWide = !scope || scope.some((p) => !all.some((c) => c.programId === p));
  const out = conns.map((c) => (usesOrgWide || c.programId ? check(c) : unusedOrgWide(check(c), 'not used by this program: it has its own auth connection')));
  // R-06: the Atlas referral panel mints widget tokens, which needs the program's widget set up.
  for (const c of conns.filter((x) => x.provider === 'atlas' && x.status === 'active')) {
    const p = programs.find((x) => x.id === c.programId);
    const w = p?.settings?.widget;
    if (p && !w?.autoEnroll && !w?.destinationUrl) {
      out.push({
        id: `widget.${p.id}`,
        status: 'warn',
        message: `program "${p.name}" has an Atlas connection but its widget isn't configured: the referral panel can't enroll users or build their links`,
        fix: `PATCH /v1/programs/${p.id} {"widget":{"autoEnroll":true,"destinationUrl":"https://your.app/signup"}}`,
      });
    }
  }
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

interface Consent { mode: string; programOverrides?: Array<{ programId: string; programName: string; mode: string }> }

/**
 * RF-2: the consent mode aff.js serves each program: its own trackingConsent, else the org's.
 * Scoped: the scope's programs. Unscoped: the org's mode, naming the programs that override it.
 */
function consentCheck(c: Consent, programs: Program[], scope: string[] | null): Check[] {
  const id = 'tracking.consent';
  const overrides = c.programOverrides ?? [];
  const own = (p: Program) => p.trackingConsent ?? overrides.find((o) => o.programId === p.id)?.mode ?? null;
  const why = 'aff.js stores the referral before the visitor chooses';
  if (scope && programs.length > 0) {
    const none = programs.filter((p) => (own(p) ?? c.mode) === 'none');
    if (none.length > 0) {
      const fixes = none.map((p) => (own(p) ? `PATCH /v1/programs/${p.id} {"trackingConsent":"auto"}` : null));
      const fix = [...new Set(fixes.map((f) => f ?? `PUT /v1/org/tracking-consent {"mode":"auto"} (or /settings → Install)`))].join('; ');
      return [{ id, status: 'warn', message: `tracking consent is 'none' for ${none.map((p) => `"${p.name}"`).join(', ')}: ${why}`, fix }];
    }
    const modes = programs.map((p) => (own(p) ? `uses ${own(p)}` : `uses the org's mode, ${c.mode}`));
    return [{ id, status: 'ok', message: programs.length === 1 ? `program ${modes[0]}` : programs.map((p, i) => `"${p.name}" ${modes[i]}`).join('; ') }];
  }
  const listed = overrides.length ? `; programs with their own mode: ${overrides.map((o) => `"${o.programName}" ${o.mode}`).join(', ')}` : '';
  // Every active program overrides 'none': the org's mode reaches nobody, so nothing to change org-wide.
  const covered = programs.length > 0 && programs.every((p) => own(p));
  return c.mode === 'none' && !covered
    ? [{ id, status: 'warn', message: `tracking consent is 'none': ${why}${listed}`, fix: `PUT /v1/org/tracking-consent {"mode":"auto"} (or /settings → Install)` }]
    : [{ id, status: 'ok', message: `tracking consent: ${c.mode}${listed}` }];
}

/** RF-2 for program-scoped keys (no org read): the same check from each program's effectiveTrackingConsent. */
function programConsentCheck(programs: Program[], scope: string[]): Check[] {
  if (programs.length === 0 || programs.some((p) => !p.effectiveTrackingConsent)) return []; // older API
  const orgMode = programs.find((p) => !p.trackingConsent)?.effectiveTrackingConsent ?? 'none';
  return consentCheck({ mode: orgMode }, programs, scope);
}

async function trackingCheck(client: Client, env: NodeJS.ProcessEnv, programs: Program[], scope: string[] | null): Promise<Check[]> {
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
      ...(await guard('tracking.consent', '/settings → Install', async () =>
        consentCheck(await client.request<Consent>('GET', '/v1/org/tracking-consent'), programs, scope),
      )),
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

interface HealthCheck { id: string; ok: boolean; detail: string; fix?: string; docs?: string; severity?: string }

/**
 * Every GET /v1/integration-health check, as `health.<id>`. A failed one is ✗ when the API marks it
 * `severity: "error"` (or critical), else ⚠. Scoped, never ✗: it may be about another program.
 */
async function healthChecks(client: Client, scope: string[] | null, billing: BillingConnection[], tally: Tally): Promise<Check[]> {
  const res = await client.request<{ checks: HealthCheck[] }>('GET', '/v1/integration-health');
  // RF-1: a check about another program's billing connection (billing.<provider>.<id>) goes into the tally.
  // Also org-wide connections, once the scoped programs have connections of their own (as in billingChecks).
  const hasOwn = !!scope && billing.some((c) => scope.some((p) => c.programIds?.includes(p)));
  const others = new Set(billing.filter((c) => outside(scope, c.programIds) || (hasOwn && !c.programIds?.length)).map((c) => c.id));
  const theirs = (h: HealthCheck) => h.id.split('.').some((part) => others.has(part));
  tally.other += res.checks.filter((h) => !h.ok && theirs(h)).length;
  return res.checks.filter((h) => !theirs(h)).map((h): Check => {
    const id = `health.${h.id}`;
    if (h.ok) return { id, status: 'ok', message: h.detail };
    const severe = !scope && (h.severity === 'error' || h.severity === 'critical');
    const fix = [h.fix, h.docs].filter(Boolean).join(' ');
    const status = severe ? 'fail' : h.severity === 'info' ? 'info' : 'warn';
    return { id, status, message: h.detail, ...(fix ? { fix } : {}) };
  });
}

/** A program settling by payout with no payout connection: partners can only be paid by hand. Test mode pays through the test rail. */
async function payoutChecks(client: Client, programs: Program[], live: boolean): Promise<Check[]> {
  const paying = programs.filter((p) => p.status === 'active' && (p.settings?.settlement ?? 'payout') === 'payout');
  if (paying.length === 0) return [];
  if (!live) return [{ id: 'payouts.connection', status: 'ok', message: 'test mode pays every method through the test rail' }];
  type Conn = { provider: string; status: string };
  const active = rows(await client.request<Conn[] | { data: Conn[] }>('GET', '/v1/payout-connections')).filter((c) => c.status === 'active');
  if (active.length) return [{ id: 'payouts.connection', status: 'ok', message: `payout connection: ${active.map((c) => c.provider).join(', ')}` }];
  const names = paying.map((p) => `"${p.name}"`).join(', ');
  return [{ id: 'payouts.connection', status: 'warn', message: `no payout connection while ${names} settle by payout: partners can only be paid by hand`, fix: 'PUT /v1/payout-connections/{provider} (Settings → Payouts), or settlement: merchant_credit' }];
}

/** Partners wait for approval (so they must hear back) but no email provider is set: nothing is sent. */
async function emailChecks(client: Client, programs: Program[]): Promise<Check[]> {
  const reviewing = programs.filter((p) => p.publicPage?.autoApprove === false);
  if (reviewing.length === 0) return [];
  const s = await client.request<{ provider: string | null; hasApiKey?: boolean }>('GET', '/v1/email/settings');
  if (s.provider && s.hasApiKey !== false) return [{ id: 'email.provider', status: 'ok', message: `email provider: ${s.provider}` }];
  const names = reviewing.map((p) => `"${p.name}"`).join(', ');
  return [{ id: 'email.provider', status: 'warn', message: `no email provider while ${names} approve partners by hand: partners get no emails`, fix: 'PUT /v1/email/settings {"provider":"…","apiKey":"…","fromAddress":"…"} (bring your own key)' }];
}

/** Approved commissions still unpaid after 30 days: a payout run is overdue (or partners have no payout method). */
async function unpaidChecks(client: Client, programs: Program[], now: Date): Promise<Check[]> {
  type Ev = { id: string; relatedCommissionId: string | null; ts: string };
  const headers = { 'referalli-version': '2026-11-01' }; // the paged list, not a pinned version's capped array
  return Promise.all(
    programs.map(async (p): Promise<Check> => {
      const q = (type: string) => listAll<Ev>(client, `/v1/commissions?programId=${encodeURIComponent(p.id)}&type=${type}`, headers);
      const [approved, paid, reversed] = await Promise.all([q('approved'), q('paid'), q('reversed')]);
      const settled = new Set([...paid, ...reversed].map((e) => e.relatedCommissionId));
      const old = approved.filter((e) => !settled.has(e.relatedCommissionId) && now.getTime() - new Date(e.ts).getTime() > 30 * DAY);
      const id = `commissions.${p.id}.unpaid`;
      return old.length
        ? { id, status: 'warn', message: `program "${p.name}": ${old.length} commission(s) approved over 30 days ago are still unpaid`, fix: 'run payouts (Payouts → Run), and check those partners have a payout method' }
        : { id, status: 'ok', message: `program "${p.name}": no approved commission has waited over 30 days` };
    }),
  );
}

/** A program with a publicHandle: the public program and its join page answer. */
async function joinChecks(client: Client, programs: Program[], fetchFn: typeof fetch): Promise<Check[]> {
  return Promise.all(
    programs
      .filter((p) => p.publicHandle)
      .map(async (p): Promise<Check> => {
        const id = `join.${p.id}`;
        const handle = encodeURIComponent(p.publicHandle!);
        const fix = `GET /v1/public/programs/${handle}; the program must be active`;
        try {
          await client.request('GET', `/v1/public/programs/${handle}`);
          const res = await fetchFn(`${client.baseUrl}/join/${handle}`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
          return res.ok
            ? { id, status: 'ok', message: `join page /join/${p.publicHandle} answers ${res.status}` }
            : { id, status: 'fail', message: `join page /join/${p.publicHandle} answers ${res.status}`, fix };
        } catch (err) {
          return { id, status: 'fail', message: `program "${p.name}" has publicHandle "${p.publicHandle}" but its public page doesn't answer: ${reason(err)}`, fix };
        }
      }),
  );
}

const MARK = { ok: '✓', info: 'ℹ', warn: '⚠', fail: '✗' } as const;

export function printChecks(out: (line: string) => void, checks: Check[], json: unknown): void {
  if (json) {
    out(JSON.stringify({ checks }, null, 2));
    return;
  }
  for (const c of checks) {
    out(`${MARK[c.status]} ${c.id}: ${c.message}`);
    if (c.fix && c.status !== 'ok' && c.status !== 'info') out(`    fix: ${c.fix}`);
  }
}

// What a program-scoped key is refused (the API's programScopedAllows), and the scope an org-wide key needs instead.
const ORG_WIDE = {
  auth: { what: 'auth connections, Atlas sign-ups', scope: 'integrations:read or connections:read' },
  tracking: { what: 'tracking token, configured token', scope: 'org:read' },
  health: { what: 'GET /v1/integration-health', scope: 'integrations:read' },
  payouts: { what: 'payout connections', scope: 'payouts:read' },
  email: { what: 'email settings', scope: 'org:read' },
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

/**
 * `referalli doctor [--program <id>] [--json]`: read-only health checks, plus `--e2e`. Exit 1 when any check fails.
 * Scope (R-08): --program (REFERALLI_PROGRAM_ID fills it in), else the key's programs, else every active program.
 */
export async function runDoctor(io: Io, client: Client, flags: Flags, now = new Date()): Promise<number> {
  const program = typeof flags.program === 'string' ? flags.program : undefined;
  const { checks: key, key: apiKey } = await keyCheck(client, now);
  const scoped = Boolean(apiKey?.programIds);
  const scope = program ? [program] : (apiKey?.programIds ?? null);
  const fetchFn = io.fetchFn ?? fetch;
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
  const tally: Tally = { other: 0 };
  let programs: Program[] = [];
  const programChecks = await guard('programs', undefined, async () => {
    programs = await loadPrograms(client, scope);
    return termsChecks(client, programs);
  });
  // Read once: the billing checks and the health checks' tally both need it (health: empty if it can't be read; billing says why).
  const billingList = client.request<BillingConnection[] | { data: BillingConnection[] }>('GET', '/v1/billing/connections').then(rows);
  const checks = [
    ...key,
    ...programChecks,
    ...(
      await Promise.all([
        guard('webhooks', undefined, () => webhookChecks(client, scope, tally)),
        guard('billing', undefined, async () => billingChecks(scope, await billingList, tally)),
        orgWide('auth', () => authChecks(client, now, programs, scope, tally)),
        orgWide('tracking', () => trackingCheck(client, io.env, programs, scope)),
        ...(scoped && scope ? [guard('tracking.consent', undefined, async () => programConsentCheck(programs, scope))] : []),
        orgWide('health', async () => healthChecks(client, scope, await billingList.catch((): BillingConnection[] => []), tally)),
        orgWide('payouts', () => payoutChecks(client, programs, apiKey?.livemode !== false)),
        orgWide('email', () => emailChecks(client, programs)),
        guard('commissions', undefined, () => unpaidChecks(client, programs, now)),
        guard('join', undefined, () => joinChecks(client, programs, fetchFn)),
        ...(flags.e2e && program ? [guard('e2e', undefined, () => e2eChecks(client, program, fetchFn, io.env))] : []),
      ])
    ).flat(),
  ];
  if (tally.other > 0) {
    const how = program ? 'run without --program (and REFERALLI_PROGRAM_ID)' : 'run with an org-wide key';
    checks.push({ id: 'scope.other', status: 'info', message: `${tally.other} issue(s) in other programs; ${how} to see them` });
  }
  printChecks((l) => io.out(l), checks, flags.json);
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
