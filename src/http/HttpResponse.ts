export interface HttpResponse<T> {
  ok: boolean;
  status: number;
  headers: Headers;
  body: T;
}
