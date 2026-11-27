import { authorizeSources, type SourcePin } from '#src/workspace/SourceDisclosure.js';

/** Serializes proposals against a turn's activation ledger. The planner runs synchronously,
 * then its original state remains visible while the host checks the selected source routes.
 * Only an admitted result consumes a disclosure budget or enters durable provenance. */
export class TurnDisclosure {
  private tail = Promise.resolve();
  constructor(private readonly assertActive: () => void) {}
  /** Serialize asynchronous package selections with path, catalog and steering disclosures. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      this.assertActive();
      const value = await work();
      this.assertActive();
      return value;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  async publish<T>(
    checkpoint: () => () => void,
    prepare: () => T,
    pins: (value: T) => readonly SourcePin[],
    signal?: AbortSignal,
  ): Promise<T> {
    const operation = this.exclusive(async () => {
      const undo = checkpoint();
      let value: T;
      let commit: () => void;
      try {
        value = prepare();
        commit = checkpoint();
      } finally {
        undo();
      }
      const check = await authorizeSources(pins(value), signal);
      check();
      this.assertActive();
      commit();
      return value;
    });
    return operation;
  }
}
