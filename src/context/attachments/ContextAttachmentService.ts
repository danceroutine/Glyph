import { WorkspaceDisclosure } from '#src/workspace/WorkspaceDisclosure.js';
import { z } from 'zod';
import { ConfigurationError } from '#src/errors/ConfigurationError.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import type { ContextAttachment } from './ContextAttachment.ts';
import type { ContextAttachmentConfiguration } from './ContextAttachmentConfiguration.ts';
import { ContextAttachmentError } from './ContextAttachmentError.ts';
import { ContextAttachmentFailureReason } from './ContextAttachmentFailureReason.ts';
import type { ContextAttachmentReference } from './ContextAttachmentReference.ts';
import { isRecord } from '#src/shared/validators/isRecord.js';

const defaults = {
  maxFiles: 32,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

const configurationSchema = z
  .object({
    maxFiles: z.number().int().positive().default(defaults.maxFiles),
    maxFileBytes: z.number().int().positive().default(defaults.maxFileBytes),
    maxTotalBytes: z.number().int().positive().default(defaults.maxTotalBytes),
  })
  .strict();

const referenceSchema = z.object({ path: z.string().min(1) }).strict();

type ResolvedConfiguration = z.output<typeof configurationSchema>;

/**
 * Resolves draft file references into fresh, exact workspace snapshots.
 * Hosts should call resolve after the prompt draft is complete and immediately
 * before invoking the selected inference provider. Inject only the deliberate-file reader. Its selection grants
 * access to the named file for this request, while enumeration and later agent reads use their project authority.
 */
export class ContextAttachmentService {
  private readonly configuration: ResolvedConfiguration;

  constructor(
    private readonly workspace: Pick<WorkspaceTextStore, 'caseSensitive' | 'normalizePath' | 'read'>,
    configuration: ContextAttachmentConfiguration = {},
  ) {
    const result = configurationSchema.safeParse(configuration);
    if (!result.success) {
      throw new ConfigurationError(`Invalid context attachment configuration: ${z.prettifyError(result.error)}`);
    }
    this.configuration = result.data;
  }

  async resolve(
    references: readonly ContextAttachmentReference[],
    disclosure = new WorkspaceDisclosure(),
  ): Promise<readonly ContextAttachment[]> {
    const paths = this.normalize(references);
    if (paths.length > this.configuration.maxFiles) {
      throw new ContextAttachmentError(
        ContextAttachmentFailureReason.FILE_COUNT_LIMIT_EXCEEDED,
        `Context contains ${paths.length} unique files, exceeding the ${this.configuration.maxFiles}-file limit.`,
        { limit: this.configuration.maxFiles, actual: paths.length },
      );
    }

    const attachments: ContextAttachment[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      const snapshot = await this.read(path, totalBytes, disclosure);
      if (snapshot.byteLength > this.configuration.maxFileBytes) {
        throw new ContextAttachmentError(
          ContextAttachmentFailureReason.FILE_SIZE_LIMIT_EXCEEDED,
          `Context attachment ${path} exceeds the ${this.configuration.maxFileBytes}-byte per-file limit.`,
          { path, limit: this.configuration.maxFileBytes, actual: snapshot.byteLength },
        );
      }
      if (snapshot.byteLength > this.configuration.maxTotalBytes - totalBytes) {
        throw new ContextAttachmentError(
          ContextAttachmentFailureReason.TOTAL_SIZE_LIMIT_EXCEEDED,
          `Context attachments exceed the ${this.configuration.maxTotalBytes}-byte total limit.`,
          { path, limit: this.configuration.maxTotalBytes, actual: totalBytes + snapshot.byteLength },
        );
      }

      totalBytes += snapshot.byteLength;
      attachments.push({
        path: snapshot.path,
        revision: snapshot.revision,
        text: snapshot.text,
        byteOrderMark: snapshot.byteOrderMark,
        byteLength: snapshot.byteLength,
      });
    }
    disclosure.assertCurrent();
    return attachments;
  }

  private normalize(references: readonly ContextAttachmentReference[]): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      let input: string;
      let path: string;
      try {
        input = referenceSchema.parse(reference).path;
        path = this.workspace.normalizePath(input);
      } catch (error) {
        const untrusted: unknown = reference;
        const candidate = isRecord(untrusted) && 'path' in untrusted ? String(untrusted.path) : undefined;
        throw new ContextAttachmentError(
          ContextAttachmentFailureReason.INVALID_REFERENCE,
          'Context attachments require a valid project-relative file path.',
          candidate === undefined ? {} : { path: candidate },
          { cause: error },
        );
      }
      const key = this.workspace.caseSensitive ? path : path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
    return paths;
  }

  private async read(
    path: string,
    totalBytes: number,
    disclosure: WorkspaceDisclosure,
  ): Promise<WorkspaceTextSnapshot> {
    try {
      return await this.workspace.read(path, {
        retainAccess: disclosure.retain,
        maxBytes: Math.min(this.configuration.maxFileBytes, this.configuration.maxTotalBytes - totalBytes),
      });
    } catch (error) {
      if (error instanceof WorkspaceReadLimitError) {
        const perFile = error.actualBytes > this.configuration.maxFileBytes;
        const reason = perFile
          ? ContextAttachmentFailureReason.FILE_SIZE_LIMIT_EXCEEDED
          : ContextAttachmentFailureReason.TOTAL_SIZE_LIMIT_EXCEEDED;
        const limit = perFile ? this.configuration.maxFileBytes : this.configuration.maxTotalBytes;
        throw new ContextAttachmentError(
          reason,
          `Context attachment ${path} exceeds the ${limit}-byte limit.`,
          {
            path,
            limit,
            actual: perFile ? error.actualBytes : totalBytes + error.actualBytes,
          },
          { cause: error },
        );
      }
      throw new ContextAttachmentError(
        ContextAttachmentFailureReason.READ_FAILED,
        `Could not resolve context attachment ${path}.`,
        { path },
        { cause: error },
      );
    }
  }
}
