import { VERSION } from './version.js';

/** A thin JSON client for the Referalli API, authenticated with the saved key. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

export interface Client {
  baseUrl: string;
  request<T = unknown>(method: string, path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T>;
}

export function createClient(opts: { baseUrl: string; key?: string; fetchFn?: FetchFn }): Client {
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  return {
    baseUrl,
    async request<T>(method: string, path: string, body?: unknown, ropts: { signal?: AbortSignal } = {}): Promise<T> {
      const headers: Record<string, string> = { 'user-agent': `referalli-cli/${VERSION}` };
      if (opts.key) headers.authorization = `Bearer ${opts.key}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ropts.signal,
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : null;
      if (!res.ok) {
        const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
        throw new ApiError(res.status, err?.code ?? null, err?.message ?? `HTTP ${res.status}`);
      }
      return data as T;
    },
  };
}
