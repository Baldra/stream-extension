/**
 * A thin fetch wrapper so every provider shares one place where the auth header
 * is attached and every HTTP failure becomes a typed error. A provider module
 * never calls `fetch` directly, which keeps error handling testable.
 */
export class HttpError extends Error {
  /** The platform's Retry-After header, when it sent one. */
  retryAfter?: string;

  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class AuthHttpError extends Error {
  constructor(readonly url: string) {
    super('the platform rejected the access token');
    this.name = 'AuthHttpError';
  }
}

export interface RequestOptions {
  accessToken?: string;
  clientId?: string;
  signal?: AbortSignal;
}

export interface HttpClient {
  readonly clientId: string;
  get<T>(url: string, options?: RequestOptions): Promise<T>;
  post<T>(url: string, body: unknown, options?: RequestOptions): Promise<T>;
}

/** Retry-After, when the platform sends one, expressed in milliseconds. */
export const retryAfterMs = (error: HttpError): number | undefined => {
  if (error.retryAfter === undefined) return undefined;
  const seconds = Number(error.retryAfter);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : undefined;
};

export const createHttpClient = (fetchImpl: typeof fetch, clientId: string): HttpClient => {
  const headers = (options: RequestOptions = {}): HeadersInit => ({
    ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
    ...(options.clientId ? { 'client-id': options.clientId } : {}),
  });

  const send = async <T>(url: string, init: RequestInit & { options?: RequestOptions }): Promise<T> => {
    const { options, ...rest } = init;
    let response: Response;
    try {
      response = await fetchImpl(url, { ...rest, headers: { ...headers(options), ...(rest.headers ?? {}) } });
    } catch {
      throw new HttpError(0, url, 'the platform could not be reached');
    }

    if (response.status === 401 || response.status === 403) throw new AuthHttpError(url);
    if (!response.ok) {
      const error = new HttpError(response.status, url, `the platform returned ${response.status}`);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) error.retryAfter = retryAfter;
      throw error;
    }
    return (await response.json()) as T;
  };

  return {
    clientId,
    get: <T>(url: string, options?: RequestOptions) =>
      send<T>(url, { method: 'GET', ...(options?.signal ? { signal: options.signal } : {}), options }),
    post: <T>(url: string, body: unknown, options?: RequestOptions) =>
      send<T>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
        options,
      }),
  };
};
