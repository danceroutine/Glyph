import { HttpError } from '../errors/HttpError.ts';
import type { Logger } from '../observability/Logger.ts';
import { HttpBodyEncoding } from './HttpBodyEncoding.ts';
import type { HttpClient } from './HttpClient.ts';
import type { HttpRequestOptions } from './HttpRequestOptions.ts';
import type { HttpResponse } from './HttpResponse.ts';
import { HttpResponseBody } from './HttpResponseBody.ts';

export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly logger: Logger,
    private readonly transport: typeof fetch = fetch,
  ) {}

  get(url: string | URL, options: HttpRequestOptions = {}): Promise<HttpResponse<unknown>> {
    return this.request('GET', url, options);
  }

  post(url: string | URL, options: HttpRequestOptions = {}): Promise<HttpResponse<unknown>> {
    return this.request('POST', url, options);
  }

  private async request(
    method: string,
    url: string | URL,
    options: HttpRequestOptions,
  ): Promise<HttpResponse<unknown>> {
    const startedAt = performance.now();
    const target = String(url);
    await this.safeLog('debug', 'http.request', { method, url: target });
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const headers = new Headers(options.headers);
      const body = encodeBody(options.body, options.bodyEncoding, headers);
      const response = await this.transport(target, {
        method,
        headers,
        redirect: options.redirect ?? 'error',
        signal,
        ...(body === undefined ? {} : { body }),
      });
      const responseBody = await decodeBody(response, options.responseBody ?? HttpResponseBody.JSON);
      await this.safeLog('debug', 'http.response', {
        method,
        url: target,
        status: response.status,
        durationMs: performance.now() - startedAt,
      });
      return { ok: response.ok, status: response.status, headers: response.headers, body: responseBody };
    } catch (error) {
      await this.safeLog('error', 'http.failure', {
        method,
        url: target,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof HttpError) throw error;
      throw new HttpError(`HTTP ${method} ${target} failed.`, { cause: error });
    }
  }

  private async safeLog(level: 'debug' | 'error', message: string, data: unknown): Promise<void> {
    try {
      await this.logger[level](message, data);
    } catch {
      // Observability must not alter request behavior.
    }
  }
}

function encodeBody(body: unknown, encoding: HttpBodyEncoding | undefined, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  switch (encoding) {
    case HttpBodyEncoding.FORM:
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      return new URLSearchParams(body as Record<string, string>);
    case HttpBodyEncoding.JSON:
      headers.set('Content-Type', 'application/json');
      return JSON.stringify(body);
    case HttpBodyEncoding.TEXT:
    case undefined:
      return String(body);
  }
}

async function decodeBody(response: Response, responseBody: HttpResponseBody): Promise<unknown> {
  switch (responseBody) {
    case HttpResponseBody.JSON:
      return response.json();
    case HttpResponseBody.TEXT:
      return response.text();
    case HttpResponseBody.NONE:
      return undefined;
  }
}
