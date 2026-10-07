import type { ProjectContextKind } from './ProjectContextKind.ts';
import type { ProjectRoot } from './ProjectRoot.ts';

/**
 * Stable host-neutral identity for the folder or multi-root workspace currently
 * open in Glyph. Chats inherit this context; they never select their own scope.
 */
export interface ProjectContext {
  readonly id: string;
  /** Changes whenever the canonical root mapping changes, even if the container ID remains stable. */
  readonly mutationIdentity: string;
  readonly kind: ProjectContextKind;
  readonly name: string;
  readonly authority: string;
  readonly roots: readonly ProjectRoot[];
  readonly workspaceFile?: string;
}
