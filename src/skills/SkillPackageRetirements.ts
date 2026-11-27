/** Shares acknowledged package replacements and removals with turns using the same desktop profile.
 * Listeners live for one turn. An ordinary refresh or an external file change grants no replay exemption. */
export class SkillPackageRetirements {
  private readonly acknowledged = new Set<string>();
  private readonly listeners = new Set<(id: string) => void>();

  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Recovery may acknowledge the same commit again while newer turns already use its replacement. */
  publish(id: string, transactionId: string): void {
    if (this.acknowledged.has(transactionId)) return;
    this.acknowledged.add(transactionId);
    for (const listener of this.listeners) {
      try {
        listener(id);
      } catch {
        // A failing subscriber cannot roll back an acknowledged commit or interrupt delivery to other turns.
      }
    }
  }

  /** A retired journal entry can only retry private cleanup. Its notification no longer needs deduplication. */
  settled(transactionId: string): void {
    this.acknowledged.delete(transactionId);
  }
}
