/** Text entered by the user plus project files explicitly attached in the host. */
export interface UserPromptDraft {
  readonly prompt: string;
  readonly attachmentPaths: readonly string[];
}
