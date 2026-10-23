/**
 * Exact decoded content plus the metadata required for lossless review and revision checks.
 *
 * Every agent edit is checked against what the agent actually read, and every write must reproduce the file
 * byte for byte apart from the reviewed change. A plain string loses the encoding marker, the permissions,
 * and any way to tell whether two reads saw the same file. This type keeps all of those so callers never
 * return to the disk to recover them.
 *
 * The filesystem store, the live editor store, and proposal compilation all produce snapshots, and review
 * checkpoints persist them. Every field must therefore mean the same thing regardless of where the snapshot
 * came from, and still hold after a restart.
 */
export interface WorkspaceTextSnapshot {
  /**
   * The normalized, workspace-relative path the snapshot was read from, prefixed with the root name in
   * multi-root workspaces. This is the spelling the agent and the review UI use. Comparing files must go
   * through `identity` instead, because two spellings can name the same file.
   */
  readonly path: string;
  /**
   * The decoded UTF-8 content without the byte order mark. Hunk offsets and diffs are computed on this text,
   * so an encoding marker must never shift them. Files that cannot be decoded without loss (binary, NUL,
   * invalid UTF-8) are rejected rather than mangled. Rewriting this text never silently corrupts a file.
   */
  readonly text: string;
  /**
   * Whether the bytes on disk start with a UTF-8 byte order mark. Kept apart from `text` so writes can
   * reproduce the original bytes exactly, and so adding or removing the marker becomes its own reviewable
   * change rather than an invisible side effect.
   */
  readonly byteOrderMark: boolean;
  /**
   * SHA-256 of the exact bytes on disk, including any byte order mark. This is the token the agent passes
   * back as `base_revision`, and every mutation checks it to avoid overwriting edits it hasn't seen. It is
   * derived from content rather than timestamps or editor versions, so it survives restarts, matches across
   * the filesystem and editor stores, and can be persisted in review checkpoints.
   */
  readonly revision: string;
  /**
   * Size of the encoded bytes, including any byte order mark. Read, attachment, and result-size budgets are
   * enforced in bytes, while `text.length` counts UTF-16 code units, which differ for non-ASCII content.
   * Carrying the encoded size spares callers from re-encoding large files just to check a limit.
   */
  readonly byteLength: number;
  /**
   * The file's permission bits. Carried along so a rewrite preserves them (writing through a temporary file
   * would otherwise reset them) and so reverting a delete restores, for example, an executable script as
   * executable. Editor-backed snapshots cannot observe real permissions and report `0o644`.
   */
  readonly mode: number;
  /**
   * Which underlying file was read, independent of how its path was spelled: device and inode on the
   * filesystem, the canonical URI in the editor. Case-insensitive filesystems and hard links let several
   * paths reach one file. Without this, a proposal or a queue of proposals could edit the same file twice
   * under different names. It also detects a file replaced mid-read and recognizes an interrupted rename
   * during recovery. Snapshots synthesized by proposals or loaded from older checkpoints carry
   * `proposed:`/`legacy:` placeholders.
   */
  readonly identity: string;
}
