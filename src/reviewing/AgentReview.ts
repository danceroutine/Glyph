/** Provider-independent, durable review state. Captures never change after admission. */
export enum AgentReviewScope {
  LAST_COMMIT = 'lastCommit',
  STAGED = 'staged',
  ALL_LOCAL = 'allLocal',
  BRANCH = 'branch',
}
export enum AgentReviewStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
  INTERRUPTED = 'interrupted',
}
export interface AgentReviewFinding {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly body: string;
}
export interface AgentReviewFile {
  readonly path: string;
  readonly uri: string;
  readonly before: string;
  readonly after: string;
  readonly contextText: string;
  readonly revision: string;
}
export interface AgentReviewInput {
  readonly id: string;
  readonly repositoryUri: string;
  readonly scope: AgentReviewScope;
  readonly branch: string;
  readonly label: string;
  readonly files: readonly AgentReviewFile[];
}
export interface AgentReviewModel {
  readonly accountProvider: string;
  readonly accountId: string;
  readonly model: string;
}
export interface AgentReview extends AgentReviewInput, AgentReviewModel {
  readonly status: AgentReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly findings: readonly AgentReviewFinding[];
  readonly dismissedIds: readonly string[];
  readonly summary: string;
  readonly error?: string;
}
