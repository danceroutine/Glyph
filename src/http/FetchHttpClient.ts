import { HttpError } from '#src/errors/HttpError.js';
import type { Logger } from '#src/observability/Logger.js';
import { HttpBodyEncoding } from './HttpBodyEncoding.ts';
import type { HttpClient } from './HttpClient.ts';
import type { HttpRequestOptions } from './HttpRequestOptions.ts';
import type { HttpResponse } from './HttpResponse.ts';
import { HttpResponseBody } from './HttpResponseBody.ts';
import { isRecord } from '#src/shared/validators/isRecord.js';

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
    // URLs and exception text can carry credentials unknown to session redaction.
    // Keep HTTP diagnostics to metadata whose values we control.
    await this.safeLog('debug', 'http.request', { method });
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
        status: response.status,
        durationMs: performance.now() - startedAt,
      });
      return { ok: response.ok, status: response.status, headers: response.headers, body: responseBody };
    } catch (error) {
      await this.safeLog('error', 'http.failure', {
        method,
        durationMs: performance.now() - startedAt,
        error: 'REQUEST_FAILED',
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

function encodeBody(body: unknown, encoding: HttpBodyEncoding.JSON, headers: Headers): string;
function encodeBody(body: unknown, encoding: HttpBodyEncoding.FORM, headers: Headers): URLSearchParams;
function encodeBody(body: unknown, encoding: HttpBodyEncoding.TEXT, headers: Headers): string;
function encodeBody(body: unknown, encoding: undefined, headers: Headers): string;
function encodeBody(body: unknown, encoding: HttpBodyEncoding | undefined, headers: Headers): BodyInit | undefined;
function encodeBody(body: unknown, encoding: HttpBodyEncoding | undefined, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  switch (encoding) {
    case HttpBodyEncoding.FORM:
      if (!isStringRecord(body)) throw new TypeError('Form bodies must map field names to string values.');
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      return new URLSearchParams(body);
    case HttpBodyEncoding.JSON:
      headers.set('Content-Type', 'application/json');
      return JSON.stringify(body);
    case HttpBodyEncoding.TEXT:
    case undefined:
      if (
        typeof body === 'string' ||
        typeof body === 'number' ||
        typeof body === 'boolean' ||
        typeof body === 'bigint' ||
        body === null
      )
        return String(body);
      throw new TypeError('Text request bodies must be primitive values.');
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

export { encodeBody as encodeBody__TESTING_ONLY, decodeBody as decodeBody__TESTING_ONLY };
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}
