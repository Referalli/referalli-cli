import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { load } from 'js-yaml';
import type { Client } from './client.js';

/**
 * `referalli plan|apply <file>`: make the account match a declarative file.
 * Every resource is matched by a stable key (program slug, webhook url, API key
 * name + owner, billing connection name, auth connection provider + instance + program); creates carry an Idempotency-Key derived from that key and the
 * request, so a retried apply never creates twice. Nothing missing from the file
 * is ever deleted, rotated or revoked.
 */

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

interface ProgramSpec extends Obj {
  slug: string;
  commissionRule?: Obj;
  stripeCredits?: Obj & { secretKeyEnv?: string };
}
interface WebhookSpec extends Obj {
  url: string;
  topics?: string[];
  programs?: string[];
  status?: 'active' | 'paused';
}
interface ApiKeySpec extends Obj {
  name: string;
  owner?: string;
  programs?: string[];
}
interface BillingConnectionSpec extends Obj {
  name: string;
  provider: string;
  programs?: string[];
  status?: 'active' | 'paused';
  stripeKeyEnv?: string;
}
interface AuthConnectionSpec extends Obj {
  provider: string;
  program: string;
  instanceId?: string;
  appId?: string;
}
export interface ApplyConfig {
  programs: ProgramSpec[];
  webhooks: WebhookSpec[];
  apiKeys: ApiKeySpec[];
  billingConnections: BillingConnectionSpec[];
  authConnections: AuthConnectionSpec[];
}

// Program fields compared against GET /v1/programs/{id} and sent as-is on PATCH.
const PROGRAM_TOP = ['name', 'attributionModel', 'cookieWindowDays', 'signupToConversionDays', 'termsMd', 'status', 'publicHandle'] as const;
// Program settings: PATCH takes them top-level, GET returns them under `settings`.
const PROGRAM_SETTINGS = ['probabilisticPolicy', 'selfReferralPolicy', 'splitCommissions', 'allowPaidSearch', 'challengeLinks', 'settlement'] as const;
// Mappings merged into what's live: only the keys the file names are compared, and PATCH sends the live block with them applied.
const PROGRAM_BLOCKS = { publicPage: ['pitch', 'autoApprove'], riskPolicy: ['holdBotScore', 'holdRiskScore', 'holdHighRiskLevel', 'holdDisposableEmail', 'holdVelocity', 'holdUnverifiedEmail', 'holdSelfReferral'] } as const;
const PROGRAM_KEYS = ['slug', ...PROGRAM_TOP, ...PROGRAM_SETTINGS, ...Object.keys(PROGRAM_BLOCKS), 'destinationUrl', 'commissionRule', 'stripeCredits'];
const STRIPE_KEYS = ['enabled', 'referrerMatch', 'metadataKey', 'refereeRewards', 'balanceCurrency', 'createCustomerIfMissing', 'waitForCustomer', 'secretKeyEnv'];
const WEBHOOK_KEYS = ['url', 'topics', 'programs', 'status', 'alertContacts'];
const API_KEY_KEYS = ['name', 'owner', 'mode', 'scopes', 'expiresInDays', 'programs', 'apiVersion'];
const BILLING_KEYS = ['name', 'provider', 'programs', 'status', 'customerRefMetadataKey', 'filter', 'stripeKeyEnv'];
// Compared only when listed. shortcut: no tokenVerification (a preset expands on save, may hold a secret) or keys (GET doesn't return them), so no drift check; set them with `referalli api`.
const AUTH_FIELDS = ['name', 'status', 'autoEnrollUsers', 'destinationUrl', 'resolveBillingCustomers', 'signatureVersion', 'allowedOrigins'];
const AUTH_KEYS = ['provider', 'program', 'instanceId', 'appId', ...AUTH_FIELDS];
// POST ignores these: they go in a PATCH right after the create.
const AUTH_PATCH_ONLY = ['status', 'resolveBillingCustomers', 'signatureVersion'];
const AUTH_PROTOCOL = ['atlas', 'custom'];
const SECRET_KEYS = ['secretKey', 'stripeKey', 'webhookSecret', 'credentials'];
// What the API stores when a rule leaves these out (packages/commissions ruleConfigSchema).
const RULE_DEFAULTS = { appliesTo: 'gross', recurring: { type: 'lifetime' }, holdDays: 30, rounding: 'half_even', overrides: [] };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKeys(o: unknown, allowed: readonly string[], where: string, required?: string): asserts o is Obj {
  if (!isObj(o)) throw new ConfigError(`${where}: expected a mapping`);
  for (const k of Object.keys(o)) {
    if (SECRET_KEYS.includes(k)) throw new ConfigError(`${where}: secrets never go in the file; use secretKeyEnv / stripeKeyEnv: ENV_VAR_NAME`);
    if (!allowed.includes(k)) throw new ConfigError(`${where}: unknown field "${k}" (allowed: ${allowed.join(', ')})`);
  }
  if (required && (typeof o[required] !== 'string' || !o[required])) throw new ConfigError(`${where}: "${required}" is required`);
}

const list = (v: unknown, where: string): unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ConfigError(`${where}: expected a list`);
  return v;
};

const authKey = (a: AuthConnectionSpec | Obj) => [a.provider, a.instanceId ?? a.appId, a.program].filter(Boolean).join(' ');

/** Parse and check a referalli.yaml (JSON is YAML too). */
export function parseConfig(text: string, file = 'config'): ApplyConfig {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (err) {
    throw new ConfigError(`${file}: ${(err as Error).message}`);
  }
  checkKeys(doc ?? {}, ['programs', 'webhooks', 'apiKeys', 'billingConnections', 'authConnections'], file);
  const d = (doc ?? {}) as Obj;
  const programs = list(d.programs, 'programs').map((p, i) => {
    const where = `programs[${i}]`;
    checkKeys(p, PROGRAM_KEYS, where, 'slug');
    if (p.commissionRule !== undefined && !isObj(p.commissionRule)) throw new ConfigError(`${where}.commissionRule: expected a mapping`);
    for (const [block, keys] of Object.entries(PROGRAM_BLOCKS)) {
      if (p[block] === undefined) continue;
      if (!isObj(p[block])) throw new ConfigError(`${where}.${block}: expected a mapping`);
      checkKeys(p[block], [...keys], `${where}.${block}`);
    }
    if (p.stripeCredits !== undefined) {
      checkKeys(p.stripeCredits, STRIPE_KEYS, `${where}.stripeCredits`);
      if (typeof p.stripeCredits.enabled !== 'boolean') throw new ConfigError(`${where}.stripeCredits: "enabled" (true/false) is required`);
    }
    return p as ProgramSpec;
  });
  const slugs = programs.map((p) => p.slug);
  const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dup) throw new ConfigError(`programs: slug "${dup}" is listed twice`);
  const webhooks = list(d.webhooks, 'webhooks').map((w, i) => {
    checkKeys(w, WEBHOOK_KEYS, `webhooks[${i}]`, 'url');
    if (w.status !== undefined && w.status !== 'active' && w.status !== 'paused') throw new ConfigError(`webhooks[${i}].status: active or paused`);
    return w as WebhookSpec;
  });
  const apiKeys = list(d.apiKeys, 'apiKeys').map((k, i) => {
    checkKeys(k, API_KEY_KEYS, `apiKeys[${i}]`, 'name');
    return k as ApiKeySpec;
  });
  const billingConnections = list(d.billingConnections, 'billingConnections').map((b, i) => {
    const where = `billingConnections[${i}]`;
    checkKeys(b, BILLING_KEYS, where, 'name');
    if (typeof b.provider !== 'string' || !b.provider) throw new ConfigError(`${where}: "provider" is required`);
    if (b.status !== undefined && b.status !== 'active' && b.status !== 'paused') throw new ConfigError(`${where}.status: active or paused`);
    if (b.stripeKeyEnv !== undefined && b.provider !== 'stripe') throw new ConfigError(`${where}: stripeKeyEnv is for provider "stripe"`);
    return b as BillingConnectionSpec;
  });
  const names = billingConnections.map((b) => b.name);
  const dupName = names.find((s, i) => names.indexOf(s) !== i);
  if (dupName) throw new ConfigError(`billingConnections: name "${dupName}" is listed twice`);
  const authConnections = list(d.authConnections, 'authConnections').map((a, i) => {
    const where = `authConnections[${i}]`;
    checkKeys(a, AUTH_KEYS, where, 'provider');
    if (typeof a.program !== 'string' || !a.program) throw new ConfigError(`${where}: "program" (a slug) is required`);
    for (const k of ['instanceId', 'appId', 'name']) {
      if (a[k] !== undefined && (typeof a[k] !== 'string' || !a[k])) throw new ConfigError(`${where}.${k}: expected a non-empty string`);
    }
    // The API drops these for other providers, so such a row could never match and each apply would create another.
    if (!AUTH_PROTOCOL.includes(a.provider as string) && (a.instanceId || a.appId || a.signatureVersion)) {
      throw new ConfigError(`${where}: instanceId, appId and signatureVersion are for provider atlas or custom`);
    }
    if (a.provider === 'atlas' && !a.instanceId === !a.appId) throw new ConfigError(`${where}: atlas needs exactly one of instanceId or appId`);
    if (a.status !== undefined && a.status !== 'active' && a.status !== 'paused') throw new ConfigError(`${where}.status: active or paused`);
    if (a.allowedOrigins !== undefined && !Array.isArray(a.allowedOrigins)) throw new ConfigError(`${where}.allowedOrigins: expected a list`);
    return a as AuthConnectionSpec;
  });
  const authKeys = authConnections.map(authKey);
  const dupAuth = authKeys.find((s, i) => authKeys.indexOf(s) !== i);
  if (dupAuth) throw new ConfigError(`authConnections: "${dupAuth}" is listed twice`);
  return { programs, webhooks, apiKeys, billingConnections, authConnections };
}

// --- planning -------------------------------------------------------------------

export type Field = [name: string, from: unknown, to: unknown];

export interface Change {
  action: 'create' | 'update' | 'noop';
  kind: string;
  label: string;
  fields: Field[];
  /** Performs the change; returns once-shown secrets as [label, value]. */
  run?: (ctx: RunCtx) => Promise<Array<[string, string]>>;
}

interface RunCtx {
  client: Client;
  /** Program slug → id, filled in as programs are created. */
  ids: Map<string, string>;
  /** Printed at once, never to --secret-file. */
  out(line: string): void;
}

interface ServerProgram {
  id: string;
  slug: string;
  settings: Obj & { widget?: { destinationUrl?: string | null } };
  [k: string]: unknown;
}

/** Key-order-insensitive JSON, for comparing values. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const same = (a: unknown, b: unknown) => canon(a ?? null) === canon(b ?? null);
const sorted = (v: string[] | null | undefined) => [...(v ?? [])].sort();

/** An Idempotency-Key that is the same for a retry of the same create, and only for that. */
const idemKey = (kind: string, key: string, body: unknown) =>
  `referalli-apply-${kind}-${createHash('sha256').update(`${key}\n${canon(body)}`).digest('hex').slice(0, 40)}`;

const create = (client: Client, path: string, kind: string, key: string, body: unknown) =>
  client.request<Obj>('POST', path, body, { headers: { 'idempotency-key': idemKey(kind, key, body) } });

/** Every row of a list endpoint: a plain array, or the 2026-11-01 list envelope followed page by page. */
export async function listAll<T extends { id: string }>(client: Client, path: string, headers?: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let url = path;
  for (;;) {
    const res = await client.request<T[] | { data: T[]; has_more?: boolean }>('GET', url, undefined, { headers });
    if (Array.isArray(res)) return res;
    out.push(...res.data);
    if (!res.has_more || res.data.length === 0) return out;
    url = `${path}${path.includes('?') ? '&' : '?'}limit=100&starting_after=${encodeURIComponent(res.data.at(-1)!.id)}`;
  }
}

const programIdsFor = (ctx: RunCtx, slugs: string[] | undefined) =>
  slugs?.length
    ? slugs.map((s) => {
        const id = ctx.ids.get(s);
        if (!id) throw new ConfigError(`unknown program "${s}" (not on the account and not in the file)`);
        return id;
      })
    : null;

/** Compare the file with the account; nothing is written. */
export async function buildPlan(client: Client, config: ApplyConfig, env: NodeJS.ProcessEnv): Promise<{ changes: Change[]; ids: Map<string, string> }> {
  const changes: Change[] = [];
  const programs = await listAll<ServerProgram>(client, '/v1/programs');
  const ids = new Map(programs.map((p) => [p.slug, p.id]));
  const slugOf = new Map(programs.map((p) => [p.id, p.slug]));
  const known = new Set([...ids.keys(), ...config.programs.map((p) => p.slug)]);
  const checkRefs = (refs: string[] | undefined, where: string) => {
    for (const s of refs ?? []) if (!known.has(s)) throw new ConfigError(`${where}: unknown program "${s}"`);
  };

  for (const spec of config.programs) {
    const cur = programs.find((p) => p.slug === spec.slug);
    const label = `program "${spec.slug}"`;
    const desired: Obj = {};
    for (const k of [...PROGRAM_TOP, ...PROGRAM_SETTINGS, ...Object.keys(PROGRAM_BLOCKS), 'destinationUrl']) if (spec[k] !== undefined) desired[k] = spec[k];
    if (!cur) {
      const { destinationUrl, ...rest } = desired;
      // POST takes the destination as the widget setting; PATCH moves it (and its links).
      const body = { slug: spec.slug, name: spec.slug, ...rest, ...(destinationUrl ? { widget: { destinationUrl } } : {}) };
      changes.push({
        action: 'create',
        kind: 'program',
        label,
        fields: Object.entries(desired).map(([k, v]) => [k, undefined, v]),
        run: async (ctx) => {
          const made = await create(ctx.client, '/v1/programs', 'program', spec.slug, body);
          ctx.ids.set(spec.slug, made.id as string);
          return [];
        },
      });
    } else {
      const now = (k: string) =>
        k === 'destinationUrl'
          ? (cur.settings.widget?.destinationUrl ?? null)
          : (PROGRAM_SETTINGS as readonly string[]).includes(k) || k === 'riskPolicy'
            ? cur.settings[k]
            : cur[k];
      // A block counts as changed only on the keys the file names; the new value is the live block with them applied.
      const want = (k: string, v: unknown) => (k in PROGRAM_BLOCKS ? { ...((now(k) as Obj | null) ?? {}), ...(v as Obj) } : v);
      const fields: Field[] = Object.entries(desired)
        .filter(([k, v]) => !same(now(k), want(k, v)))
        .map(([k, v]) => [k, now(k), want(k, v)]);
      const patch = Object.fromEntries(fields.map(([k, , v]) => [k, v]));
      changes.push({
        action: fields.length ? 'update' : 'noop',
        kind: 'program',
        label,
        fields,
        run: async (ctx) => {
          await ctx.client.request('PATCH', `/v1/programs/${cur.id}`, patch);
          return [];
        },
      });
    }

    if (spec.commissionRule) {
      const want = { ...RULE_DEFAULTS, ...spec.commissionRule };
      const rlabel = `commissionRule "${spec.slug}"`;
      const latest = cur ? (await listAll<{ id: string; version: number; config: Obj }>(client, `/v1/commission-rules?programId=${encodeURIComponent(cur.id)}`))[0] : undefined;
      const publish = async (ctx: RunCtx) => {
        const programId = ctx.ids.get(spec.slug)!;
        await create(ctx.client, '/v1/commission-rules', 'rule', spec.slug, { programId, config: spec.commissionRule });
        return [];
      };
      if (!latest) {
        changes.push({ action: 'create', kind: 'commissionRule', label: rlabel, fields: Object.entries(spec.commissionRule).map(([k, v]) => [k, undefined, v]), run: publish });
      } else {
        const keys = [...new Set([...Object.keys(want), ...Object.keys(latest.config)])];
        const fields: Field[] = keys.filter((k) => !same(latest.config[k], (want as Obj)[k])).map((k) => [k, latest.config[k], (want as Obj)[k]]);
        changes.push({ action: fields.length ? 'update' : 'noop', kind: 'commissionRule', label: `${rlabel} (v${latest.version})`, fields, run: publish });
      }
    }

    if (spec.stripeCredits) {
      const { secretKeyEnv, ...s } = spec.stripeCredits;
      // Every field, defaults included: the PUT replaces the settings, so one left out would be switched off.
      const want: Obj = {
        enabled: s.enabled,
        referrerMatch: s.referrerMatch ?? 'billing_link',
        metadataKey: s.metadataKey ?? null,
        refereeRewards: s.refereeRewards ?? false,
        balanceCurrency: typeof s.balanceCurrency === 'string' ? s.balanceCurrency.toLowerCase() : null,
        createCustomerIfMissing: s.createCustomerIfMissing ?? null,
        waitForCustomer: s.waitForCustomer ?? false,
      };
      const curS = cur ? await client.request<Obj & { hasOwnKey: boolean }>('GET', `/v1/programs/${cur.id}/stripe-credits`) : null;
      const fields: Field[] = Object.keys(want)
        .filter((k) => !curS || !same(curS[k], want[k]))
        .map((k) => [k, curS?.[k], want[k]]);
      // shortcut: the API never returns the key, so one already set is left alone; replace it with `referalli api PUT`.
      const sendKey = Boolean(secretKeyEnv) && !curS?.hasOwnKey;
      if (sendKey) {
        if (!env[secretKeyEnv!]) throw new ConfigError(`programs "${spec.slug}".stripeCredits: environment variable ${secretKeyEnv} is not set`);
        fields.push(['secretKey', curS ? '(none)' : undefined, `(from $${secretKeyEnv})`]);
      }
      changes.push({
        action: !curS ? 'create' : fields.length ? 'update' : 'noop',
        kind: 'stripeCredits',
        label: `stripeCredits "${spec.slug}"`,
        fields,
        run: async (ctx) => {
          const body = { ...want, metadataKey: want.metadataKey ?? undefined, ...(sendKey ? { secretKey: env[secretKeyEnv!] } : {}) };
          await ctx.client.request('PUT', `/v1/programs/${ctx.ids.get(spec.slug)}/stripe-credits`, body);
          return [];
        },
      });
    }
  }

  if (config.webhooks.length) {
    const endpoints = await listAll<{ id: string; url: string; topics: string[]; programIds: string[] | null; status: string; alertContacts: string[] }>(
      client,
      '/v1/webhook-endpoints',
    );
    for (const spec of config.webhooks) {
      checkRefs(spec.programs, `webhook ${spec.url}`);
      const cur = endpoints.find((e) => e.url === spec.url);
      const want: Obj = { topics: sorted(spec.topics ?? ['*']), programs: sorted(spec.programs), status: spec.status ?? 'active' };
      if (spec.alertContacts !== undefined) want.alertContacts = sorted(spec.alertContacts as string[]);
      const label = `webhook ${spec.url}`;
      const body = (ctx: RunCtx) => ({
        topics: want.topics,
        programIds: programIdsFor(ctx, spec.programs),
        status: want.status,
        ...(want.alertContacts ? { alertContacts: want.alertContacts } : {}),
      });
      if (!cur) {
        changes.push({
          action: 'create',
          kind: 'webhook',
          label,
          fields: Object.entries(want).map(([k, v]) => [k, undefined, v]),
          run: async (ctx) => {
            const made = await create(ctx.client, '/v1/webhook-endpoints', 'webhook', spec.url, { url: spec.url, ...body(ctx) });
            return [[`webhook ${spec.url}`, made.secret as string]];
          },
        });
        continue;
      }
      const now: Obj = {
        topics: sorted(cur.topics),
        programs: sorted((cur.programIds ?? []).map((id) => slugOf.get(id) ?? id)),
        status: cur.status,
        alertContacts: sorted(cur.alertContacts),
      };
      const fields: Field[] = Object.keys(want).filter((k) => !same(now[k], want[k])).map((k) => [k, now[k], want[k]]);
      changes.push({
        action: fields.length ? 'update' : 'noop',
        kind: 'webhook',
        label,
        fields,
        run: async (ctx) => {
          await ctx.client.request('PATCH', `/v1/webhook-endpoints/${cur.id}`, body(ctx));
          return [];
        },
      });
    }
  }

  for (const spec of config.apiKeys) {
    checkRefs(spec.programs, `apiKey "${spec.name}"`);
    const owner = spec.owner ?? null;
    const label = `apiKey "${spec.name}"${owner ? ` (owner ${owner})` : ''}`;
    const existing = await listAll<{ id: string; name: string; owner: string | null; revokedAt: string | null }>(
      client,
      `/v1/api-keys${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`,
    );
    // Create-only: an existing key is never rotated, revoked or edited from the file.
    if (existing.some((k) => k.name === spec.name && (k.owner ?? null) === owner && !k.revokedAt)) {
      changes.push({ action: 'noop', kind: 'apiKey', label, fields: [] });
      continue;
    }
    const { programs: refs, ...rest } = spec;
    const shown = { mode: 'both', ...rest };
    changes.push({
      action: 'create',
      kind: 'apiKey',
      label,
      fields: Object.entries({ ...shown, ...(refs ? { programs: refs } : {}) }).map(([k, v]) => [k, undefined, v]),
      run: async (ctx) => {
        const programIds = programIdsFor(ctx, refs);
        const res = await create(ctx.client, '/v1/api-keys', 'apikey', `${spec.name}\n${owner ?? ''}`, { ...shown, ...(programIds ? { programIds } : {}) });
        const issued = (isObj(res.live) ? [res.live, res.test] : [res]) as Array<{ livemode: boolean; key: string }>;
        return issued.map((k) => [`apiKey ${spec.name}${owner ? ` (${owner})` : ''} ${k.livemode ? 'live' : 'test'}`, k.key]);
      },
    });
  }
  if (config.billingConnections.length) {
    const conns = await listAll<{ id: string; name: string; provider: string; status: string; programIds: string[] | null; customerRefMetadataKey: string | null; filter: unknown }>(
      client,
      '/v1/billing/connections',
    );
    for (const spec of config.billingConnections) {
      const label = `billingConnection "${spec.name}"`;
      checkRefs(spec.programs, label);
      const matches = conns.filter((c) => c.name === spec.name);
      if (matches.length > 1) throw new ConfigError(`${label}: ${matches.length} connections on the account have this name; rename all but one (PATCH /v1/billing/connections/{id})`);
      const cur = matches[0];
      // programs and status are always managed (like webhooks); the optional fields only when the file sets them (null clears).
      const want: Obj = { programs: sorted(spec.programs), status: spec.status ?? 'active' };
      for (const k of ['customerRefMetadataKey', 'filter']) if (spec[k] !== undefined) want[k] = spec[k];
      const apiBody = (ctx: RunCtx, keys: string[]) =>
        Object.fromEntries(keys.map((k) => (k === 'programs' ? ['programIds', programIdsFor(ctx, spec.programs)] : [k, want[k]])));
      if (!cur) {
        const key = spec.stripeKeyEnv;
        if (key && !env[key]) throw new ConfigError(`${label}: environment variable ${key} is not set`);
        const { status, ...createFields } = want;
        changes.push({
          action: 'create',
          kind: 'billingConnection',
          label,
          fields: [
            ['provider', undefined, spec.provider],
            ...Object.entries(want).map(([k, v]): Field => [k, undefined, v]),
            ...(key ? [['stripeKey', undefined, `(from $${key})`] as Field] : []),
          ],
          run: async (ctx) => {
            const body = { name: spec.name, provider: spec.provider, ...apiBody(ctx, Object.keys(createFields).filter((k) => createFields[k] !== null)), ...(key ? { stripeKey: env[key] } : {}) };
            const made = await create(ctx.client, '/v1/billing/connections', 'billing', spec.name, body);
            // POST takes no status: pause right after creating.
            if (status === 'paused') await ctx.client.request('PATCH', `/v1/billing/connections/${made.id as string}`, { status });
            // awaiting_secret: the generated secret can't verify this provider; the provider's own is set later with PUT …/secret.
            return typeof made.webhookSecret === 'string' && made.status !== 'awaiting_secret' ? [[label, made.webhookSecret]] : [];
          },
        });
        continue;
      }
      if (cur.provider !== spec.provider) {
        throw new ConfigError(`${label}: the account's connection is provider "${cur.provider}", the file says "${spec.provider}"; a provider can't be changed`);
      }
      const now: Obj = {
        programs: sorted((cur.programIds ?? []).map((id) => slugOf.get(id) ?? id)),
        status: cur.status === 'awaiting_secret' ? 'active' : cur.status,
        customerRefMetadataKey: cur.customerRefMetadataKey,
        filter: cur.filter,
      };
      const fields: Field[] = Object.keys(want).filter((k) => !same(now[k], want[k])).map((k) => [k, now[k], want[k]]);
      changes.push({
        action: fields.length ? 'update' : 'noop',
        kind: 'billingConnection',
        label,
        fields,
        run: async (ctx) => {
          await ctx.client.request('PATCH', `/v1/billing/connections/${cur.id}`, apiBody(ctx, fields.map(([k]) => k)));
          return [];
        },
      });
    }
  }
  if (config.authConnections.length) {
    const conns = await listAll<Obj & { id: string; provider: string; programId: string; instanceId?: string | null; appId?: string | null; allowedOrigins: string[] }>(client, '/v1/auth/connections');
    for (const spec of config.authConnections) {
      const label = `authConnection "${authKey(spec)}"`;
      checkRefs([spec.program], label);
      const matches = conns.filter(
        (c) => c.provider === spec.provider && c.programId === ids.get(spec.program) && (c.instanceId ?? null) === (spec.instanceId ?? null) && (c.appId ?? null) === (spec.appId ?? null),
      );
      if (matches.length > 1) throw new ConfigError(`${label}: ${matches.length} connections on the account match (${matches.map((c) => c.id).join(', ')}); delete the extras (DELETE /v1/auth/connections/{id})`);
      const cur = matches[0];
      const want: Obj = {};
      for (const k of AUTH_FIELDS) if (spec[k] !== undefined) want[k] = k === 'allowedOrigins' ? sorted(spec[k] as string[]) : spec[k];
      if (!cur) {
        const { provider, program, instanceId, appId } = spec;
        changes.push({
          action: 'create',
          kind: 'authConnection',
          label,
          fields: Object.entries({ provider, program, instanceId, appId, ...want }).filter(([, v]) => v !== undefined).map(([k, v]): Field => [k, undefined, v]),
          run: async (ctx) => {
            const onCreate = Object.entries(want).filter(([k, v]) => !AUTH_PATCH_ONLY.includes(k) && v !== null);
            const made = await create(ctx.client, '/v1/auth/connections', 'auth', authKey(spec), {
              provider,
              programId: programIdsFor(ctx, [program])![0],
              ...(instanceId ? { instanceId } : {}),
              ...(appId ? { appId } : {}),
              ...Object.fromEntries(onCreate),
            });
            // Printed before the PATCH: if that fails the secret still reached the user. It can't be fetched again.
            ctx.out(`${label} is ${made.id as string}. Its signing secret, shown once and saved nowhere (--secret-file doesn't take it), so store it now: ${made.secret as string}`);
            const after = Object.entries(want).filter(([k]) => AUTH_PATCH_ONLY.includes(k));
            if (after.length) await ctx.client.request('PATCH', `/v1/auth/connections/${made.id as string}`, Object.fromEntries(after));
            return [];
          },
        });
        continue;
      }
      const now = (k: string) => (k === 'allowedOrigins' ? sorted(cur.allowedOrigins) : cur[k]);
      const fields: Field[] = Object.keys(want).filter((k) => !same(now(k), want[k])).map((k) => [k, now(k), want[k]]);
      changes.push({
        action: fields.length ? 'update' : 'noop',
        kind: 'authConnection',
        label,
        fields,
        run: async (ctx) => {
          await ctx.client.request('PATCH', `/v1/auth/connections/${cur.id}`, Object.fromEntries(fields.map(([k, , v]) => [k, v])));
          return [];
        },
      });
    }
  }
  return { changes, ids };
}

// --- output ----------------------------------------------------------------------

const show = (v: unknown) => (v === undefined ? '(unset)' : JSON.stringify(v));
const SIGN = { create: '+ create', update: '~ update', noop: '= unchanged' } as const;

/** Plan lines. Values come from the file and the API's public fields: no secret is ever in them. */
export function formatPlan(changes: Change[]): string[] {
  const lines: string[] = [];
  for (const c of changes) {
    lines.push(`${SIGN[c.action]} ${c.label}`);
    for (const [k, from, to] of c.fields) lines.push(c.action === 'create' ? `    ${k}: ${show(to)}` : `    ${k}: ${show(from)} → ${show(to)}`);
  }
  const n = (a: Change['action']) => changes.filter((c) => c.action === a).length;
  lines.push(`Plan: ${n('create')} to create, ${n('update')} to update, ${n('noop')} unchanged.`);
  return lines;
}

export interface ApplyIo {
  out(line: string): void;
  env: NodeJS.ProcessEnv;
}

/**
 * Plan (and with `apply`, perform) the file. Returns the exit code: 0, or 2
 * with `check` when anything would change.
 */
export async function runApply(
  io: ApplyIo,
  client: Client,
  file: string,
  opts: { apply: boolean; check: boolean; secretFile?: string },
): Promise<number> {
  const config = parseConfig(readFileSync(file, 'utf8'), file);
  const { changes, ids } = await buildPlan(client, config, io.env);
  for (const line of formatPlan(changes)) io.out(line);
  const pending = changes.filter((c) => c.action !== 'noop');
  if (opts.check) {
    if (pending.length) io.out('Drift: the account does not match the file.');
    return pending.length ? 2 : 0; // 2, not 1: CI can tell drift from an error
  }
  if (!opts.apply || pending.length === 0) return 0;
  // Checked first: a secret file that can't be written after the creates would lose the secrets.
  if (opts.secretFile && existsSync(opts.secretFile)) throw new ConfigError(`--secret-file ${opts.secretFile} already exists; pick a new path`);
  const ctx: RunCtx = { client, ids, out: (line) => io.out(line) };
  const secrets: Array<[string, string]> = [];
  try {
    for (const c of pending) {
      secrets.push(...(await c.run!(ctx)));
      io.out(`${c.action === 'create' ? 'Created' : 'Updated'} ${c.label}`);
    }
  } finally {
    // Even when a later change fails, secrets already issued are handed over: they can't be fetched again.
    if (secrets.length && opts.secretFile) {
      writeFileSync(opts.secretFile, `${JSON.stringify(Object.fromEntries(secrets), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(opts.secretFile, 0o600);
      io.out(`New secrets written to ${opts.secretFile} (mode 600). They are shown once.`);
    } else if (secrets.length) {
      io.out('New secrets, shown once. Store them now:');
      for (const [label, value] of secrets) io.out(`  ${label}  ${value}`);
    }
  }
  io.out(`Apply complete: ${pending.length} change(s).`);
  return 0;
}
