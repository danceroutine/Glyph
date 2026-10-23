import { FileEditPlan, type FileEditPlanRecord } from './FileEditPlan.ts';
import type { EditProposalOrigin } from './EditProposalOrigin.ts';

/** Persisted representation of a proposal, containing data only and no live domain objects. */
export interface EditProposalRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: 'patch' | 'structured';
  readonly createdAt: string;
  readonly files: FileEditPlanRecord[];
  readonly origin?: EditProposalOrigin | undefined;
  /** Delivery receipts persisted with the proposal so review feedback is exactly-once across restarts. */
  acknowledgedResultIds?: string[] | undefined;
}

/**
 * One agent-authored change set and the file plans whose review state advances together.
 *
 * The proposal owns the boundary between persisted records and live {@link FileEditPlan} instances. This keeps
 * callers from remembering to hydrate every nested plan whenever a proposal is created, copied, or restored.
 */
export class EditProposal implements EditProposalRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: 'patch' | 'structured';
  readonly createdAt: string;
  readonly files: FileEditPlan[];
  readonly origin?: EditProposalOrigin | undefined;
  /** Delivery receipts persisted with the proposal so review feedback is exactly-once across restarts. */
  acknowledgedResultIds?: string[] | undefined;

  /**
   * Keeps construction behind {@link EditProposal.from} so nested file plans are hydrated through one path at
   * every creation and persistence boundary.
   */
  private constructor(record: EditProposalRecord) {
    this.schemaVersion = record.schemaVersion;
    this.id = record.id;
    this.source = record.source;
    this.createdAt = record.createdAt;
    this.files = record.files.map(file => FileEditPlan.from(file));
    this.origin = record.origin;
    this.acknowledgedResultIds = record.acknowledgedResultIds;
  }

  /**
   * Produces the live proposal expected by review code while preserving identity when the value is already
   * hydrated. Identity preservation matters because staging callers may retain the proposal they submitted.
   */
  static from(record: EditProposalRecord | EditProposal): EditProposal {
    return record instanceof EditProposal ? record : new EditProposal(record);
  }

  /**
   * Attaches host-owned provenance after compilation without exposing a writable origin or stripping the proposal's
   * prototype through object spread. File-plan identities remain stable because the review has not forked.
   */
  withOrigin(origin: EditProposalOrigin): EditProposal {
    return new EditProposal({
      schemaVersion: this.schemaVersion,
      id: this.id,
      source: this.source,
      createdAt: this.createdAt,
      files: this.files,
      origin,
      acknowledgedResultIds: this.acknowledgedResultIds,
    });
  }

  /**
   * Exposes a data-only persistence shape so checkpoints do not rely on class serialization and every nested
   * file plan crosses the same explicit record boundary.
   */
  toRecord(): EditProposalRecord {
    return {
      schemaVersion: this.schemaVersion,
      id: this.id,
      source: this.source,
      createdAt: this.createdAt,
      files: this.files.map(file => file.toRecord()),
      ...(this.origin ? { origin: this.origin } : {}),
      ...(this.acknowledgedResultIds ? { acknowledgedResultIds: this.acknowledgedResultIds } : {}),
    };
  }
}
