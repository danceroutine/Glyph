import type { HttpRequestOptions } from './HttpRequestOptions.ts';
import type { HttpResponse } from './HttpResponse.ts';

export interface HttpClient {
  get(url: string | URL, options?: HttpRequestOptions): Promise<HttpResponse<unknown>>;
  post(url: string | URL, options?: HttpRequestOptions): Promise<HttpResponse<unknown>>;
}
