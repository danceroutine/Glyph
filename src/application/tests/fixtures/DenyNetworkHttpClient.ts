import type { HttpClient } from '../../../http/HttpClient.ts';
import type { HttpResponse } from '../../../http/HttpResponse.ts';

export class DenyNetworkHttpClient implements HttpClient {
  attempts = 0;
  async get(): Promise<HttpResponse<unknown>> { this.attempts++; throw new Error('HTTP access is forbidden in editing E2E tests.'); }
  async post(): Promise<HttpResponse<unknown>> { this.attempts++; throw new Error('HTTP access is forbidden in editing E2E tests.'); }
}
