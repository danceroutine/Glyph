import { z } from 'zod';
import { ConfigurationError } from '../../errors/ConfigurationError.ts';
import type { WorkspaceTextSnapshot } from '../../workspace/WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from '../../workspace/WorkspaceTextStore.ts';
import type { ContextAttachment } from './ContextAttachment.ts';
import type { ContextAttachmentConfiguration } from './ContextAttachmentConfiguration.ts';
import { ContextAttachmentError } from './ContextAttachmentError.ts';
import { ContextAttachmentFailureReason } from './ContextAttachmentFailureReason.ts';
import type { ContextAttachmentReference } from './ContextAttachmentReference.ts';

const defaults = {
  maxFiles: 32,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

const configurationSchema = z
  .object({
    maxFiles: z.number().int().positive().safe().default(defaults.maxFiles),
    maxFileBytes: z.number().int().positive().safe().default(defaults.maxFileBytes),
    maxTotalBytes: z.number().int().positive().safe().default(defaults.maxTotalBytes),
  })
  .strict();

const referenceSchema = z.object({ path: z.string().min(1) }).strict();

type ResolvedConfiguration = z.output<typeof configurationSchema>;

/**
 * Resolves draft file references into fresh, exact workspace snapshots.
 * Hosts should call resolve after the prompt draft is complete and immediately
 * before invoking the selected inference provider.
 */
export class ContextAttachmentService {
  private readonly configuration: ResolvedConfiguration;

  constructor(
    private readonly workspace: WorkspaceTextStore,
    configuration: ContextAttachmentConfiguration = {},
  ) {
    const result = configurationSchema.safeParse(configuration);
    if (!result.success) {
      throw new ConfigurationError(`Invalid context attachment configuration: ${z.prettifyError(result.error)}`);
    }
    this.configuration = result.data;
  }

  async resolve(references: readonly ContextAttachmentReference[]): Promise<readonly ContextAttachment[]> {
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
      const snapshot = await this.read(path);
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
        const candidate =
          typeof reference === 'object' && reference !== null && 'path' in reference
            ? String(reference.path)
            : undefined;
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

  private async read(path: string): Promise<WorkspaceTextSnapshot> {
    try {
      return await this.workspace.read(path);
    } catch (error) {
      throw new ContextAttachmentError(
        ContextAttachmentFailureReason.READ_FAILED,
        `Could not resolve context attachment ${path}.`,
        { path },
        { cause: error },
      );
    }
  }
}
