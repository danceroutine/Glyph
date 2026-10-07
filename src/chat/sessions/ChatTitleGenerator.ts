/** Produces a short display name from the first human message in a chat. */
export interface ChatTitleGenerator {
  generate(firstMessage: string): Promise<string>;
}
