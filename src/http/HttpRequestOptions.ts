import type { HttpBodyEncoding } from './HttpBodyEncoding.ts';
import type { HttpResponseBody } from './HttpResponseBody.ts';

export interface HttpRequestOptions {
  headers?: HeadersInit;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
  timeoutMs?: number;
  body?: unknown;
  bodyEncoding?: HttpBodyEncoding;
  responseBody?: HttpResponseBody;
}
