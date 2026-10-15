import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';

/** Rejects filenames that Unicode encoders would silently replace with a different path. */
export function assertWellFormedWorkspacePath(path: string): void {
  if (/[\uD800-\uDFFF]/u.test(path)) {
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Path contains an unpaired UTF-16 surrogate.', { path });
  }
}
