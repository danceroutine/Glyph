/** Bridges an imperative host API to a result completed by a React event. */
export class Deferred<Result> {
  readonly promise: Promise<Result>;
  readonly resolve: (result: Result | PromiseLike<Result>) => void;
  readonly reject: (reason?: unknown) => void;

  constructor() {
    let resolve!: Deferred<Result>['resolve'];
    let reject!: Deferred<Result>['reject'];
    this.promise = new Promise<Result>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.resolve = resolve;
    this.reject = reject;
  }
}
