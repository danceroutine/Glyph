import type { HttpClient } from '#src/http/HttpClient.js';
import type { HttpResponse } from '#src/http/HttpResponse.js';

export class DenyNetworkHttpClient implements HttpClient {
  attempts = 0;
  async get(): Promise<HttpResponse<unknown>> {
    this.attempts++;
    throw new Error('HTTP access is forbidden in editing E2E tests.');
  }
  async post(): Promise<HttpResponse<unknown>> {
    this.attempts++;
    throw new Error('HTTP access is forbidden in editing E2E tests.');
  }
}
