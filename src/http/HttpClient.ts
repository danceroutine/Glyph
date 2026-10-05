import type { HttpRequestOptions } from './HttpRequestOptions.ts';
import type { HttpResponse } from './HttpResponse.ts';

/** Injectable HTTP boundary for authentication, discovery, and observability. */
export interface HttpClient {
  get(url: string | URL, options?: HttpRequestOptions): Promise<HttpResponse<unknown>>;
  post(url: string | URL, options?: HttpRequestOptions): Promise<HttpResponse<unknown>>;
}
