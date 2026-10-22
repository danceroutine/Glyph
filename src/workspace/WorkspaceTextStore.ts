import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceReadOptions } from './WorkspaceReadOptions.ts';
import type { WorkspaceMutationOptions } from './WorkspaceMutationOptions.ts';
import type { WorkspaceMutationConsistency } from './WorkspaceMutationConsistency.ts';

/**
 * Host-neutral project text port. Implementations provide exact snapshots and
 * revision-guarded mutations. Adapters must declare whether the revision check
 * is atomic with the mutation. A Code OSS/editor adapter must use the editor's
 * versioned mutation primitive and expose `ATOMIC_VERSIONED`; checking a
 * document version and then issuing an unrelated edit is not sufficient.
 *
 * The same proposal and review logic runs against raw files on disk and against live editor buffers, where
 * unsaved edits are the truth the user sees. Keeping that difference behind one port means the review
 * guarantees (no lost edits, no writes on outdated assumptions) are written once instead of per host.
 */
export interface WorkspaceTextStore {
  /**
   * The absolute directory every path is relative to. It also serves as the default identity under which
   * review checkpoints are stored, so a review planned against one project is never reloaded against another.
   */
  readonly root: string;
  /**
   * Whether paths differing only in case name different files. Proposals and attachments use it to catch two
   * spellings of one file, which would otherwise be edited twice or attached twice. A multi-root store
   * reports case-insensitive if any root is, so it errs toward treating spellings as collisions.
   */
  readonly caseSensitive: boolean;
  /**
   * How much the revision guard on mutations actually guarantees. Plain filesystems cannot compare-and-swap
   * by content, so an external writer can still slip in between the check and the write. Editors can make
   * the check and the edit one operation. A multi-root store reports the weakest of its roots. Nothing in the
   * editing domain branches on it yet. It records the guarantee so that logic needing strict atomicity can
   * check for it instead of assuming it.
   *
   * TODO: This doesn't seem to be used anywhere except stores and tests
   */
  readonly mutationConsistency: WorkspaceMutationConsistency;
  /**
   * Lists files the agent may access. The `maxFiles` cap keeps one call from walking a huge repository, and
   * `truncated` tells the agent the list is incomplete, so a missing entry is not taken as proof that a file
   * does not exist. Excluded, ignored, and symlinked entries are omitted, matching what `normalizePath`
   * allows, so the agent is never shown a path it cannot then open.
   */
  list(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }>;
  /**
   * Converts agent- or user-supplied input into the single project-relative spelling used everywhere else,
   * and rejects paths outside the project or excluded by access policy. Normalizing at this one point
   * ensures path comparisons, policy checks, and persisted reviews all see the same spelling.
   */
  normalizePath(path: string): string;
  /**
   * Resolves existing or prospective files to an absolute, slash-delimited path
   * for collision checks, including ancestor conflicts. Keys use the adapter's
   * filesystem casing rules; snapshot identities additionally detect hard links.
   *
   * Mode policy (such as Plan Mode's Markdown-only rule) checks every proposed source and destination twice:
   * once as the agent spelled it, and once as this canonical path. The edit is denied if either check fails.
   * Policies are written against names, but the name the agent writes is not always the name of the file
   * that gets written. On a case-insensitive filesystem, or through the editor's URI canonicalization, one
   * spelling can resolve to a file whose real path a policy would reject. For example, a case-sensitive rule
   * protecting `docs/` would wave through `DOCS/plan.md` on macOS if only the agent's spelling were checked.
   *
   * Canonical paths are absolute, so policies must accept both forms. Symlinks never reach this point
   * because the filesystem store rejects them. Hard links are not resolved here, so no policy can see
   * through a pre-existing hard link to the file it shares content with.
   */
  canonicalPath(path: string): Promise<string>;
  /**
   * Checks occupancy without reading content; directories and binary files also occupy a target.
   *
   * Collision checks before a create or rename only need to know whether the path is taken, so reading the
   * file would be wasted work. Reading is also the wrong tool for this. `read` only accepts files it can
   * turn into a reviewable text snapshot. It rejects directories, binary files (any NUL byte), content that
   * is not valid UTF-8, files over the read budget, and special files such as pipes or sockets. Every one of
   * those still occupies the path, and creating or renaming onto it would fail or destroy it. A collision
   * check built on `read` would end in an unsupported-file error instead of a clear "target exists" answer,
   * and would load a potentially huge file just to learn that it is there.
   */
  exists(path: string): Promise<boolean>;
  /**
   * Returns the authoritative content for a file. In the editor this includes unsaved changes, because that
   * is what the user is looking at and what a later save will write. `maxBytes` rejects oversized files
   * before they are loaded, so an agent request cannot exhaust host memory.
   */
  read(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceTextSnapshot>;
  /**
   * Like `read`, but returns `undefined` only when the file is genuinely absent. Directories, binary files,
   * and over-budget files still throw. Recovery relies on that distinction: an unreadable file must never
   * be mistaken for proof that a pending delete already ran.
   */
  readOptional(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceTextSnapshot | undefined>;
  /**
   * Creates a file and fails if the path is already occupied. A create is approved on the assumption that
   * nothing was there, so silently overwriting whatever appeared since would destroy unreviewed content.
   * Returns the resulting snapshot rather than echoing the input, so the caller records the revision that
   * actually landed. `mode` lets reverting a delete restore the original permissions. Editor-backed stores
   * cannot set permissions and ignore it.
   */
  create(
    path: string,
    text: string,
    byteOrderMark: boolean,
    // TODO we probably should make this an enum so it's not just magic numbers everywhere.
    mode?: number,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot>;
  /**
   * Replaces a file's content only if it still has `expectedRevision`, so an accepted hunk never overwrites
   * edits the review hasn't seen. `byteOrderMark` is explicit so the write reproduces the reviewed encoding
   * instead of silently changing it. The returned snapshot may differ from `text`, because editors can
   * normalize line endings or whitespace. Callers must rebase remaining hunks against what actually landed,
   * not against what they asked for.
   *
   * @param byteOrderMark Whether the written file should start with a UTF-8 byte order mark, the three bytes
   * `EF BB BF` that some tools (notably on Windows) use to recognize a file as UTF-8. `text` never contains
   * the marker. The store prepends it to the encoded bytes when this is `true` and writes the text as is when
   * it is `false`. A U+FEFF character at the start of `text` is ordinary content, written in addition to any
   * marker. Because the revision hashes the exact bytes, this flag alone changes the resulting revision, even
   * when `text` is identical. Callers pass the plan's reviewed choice (`proposed.byteOrderMark`) on accept and
   * the value from before the edit on revert, so the marker only changes when the human approved that change.
   * Editor-backed stores cannot toggle the marker on an open document and reject any value that differs from
   * its current state.
   */
  replace(
    path: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot>;
  /**
   * Moves a file only if the source still has `expectedRevision` and the target is free. Overwriting a target
   * that appeared since the proposal would destroy someone else's file. The filesystem store therefore
   * links, then unlinks, rather than renaming. A crash between those steps leaves both paths pointing at one
   * file, which recovery recognizes through snapshot identity. Returns the snapshot at the target so the
   * plan can follow the file to its new path.
   */
  rename(
    source: string,
    target: string,
    expectedRevision: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot>;
  /**
   * Deletes a file only if it still has `expectedRevision`. A delete was approved for the content the human
   * reviewed, and deleting different content would discard edits nobody saw.
   *
   * TODO: Revisit this and decide whether we should allow deleting files that have been modified since the expected revision. Otherwise agents swarming in tandem could block one another from deleting files
   */
  delete(path: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<void>;
}
