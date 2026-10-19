export class WebRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source?: { readonly title: string; readonly url: string },
  ) {
    super(message);
  }
}
