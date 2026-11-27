import { fileURLToPath, pathToFileURL } from 'node:url';
import { storedSourcePath } from '#src/workspace/SourcePathAliases.js';
import { isAbsolute, relative, sep } from 'node:path';
import { isRecord } from '#src/shared/validators/isRecord.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import {
  GlyphContextAttachmentKind as Kind,
  type GlyphContextAttachment,
  type GlyphAttachmentResource,
  type GlyphFolderListing,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import {
  formatFolderAttachment,
  formatFolderContextOutline,
} from '#src/desktop/workbench/formatFolderContextOutline.js';

/**
 * Admits desktop captures at the host boundary. An explicit file keeps the bytes and revision the user
 * selected in the editor. A directory can disclose only names returned by the project index. Call again
 * on Send or Steer so a saved capture cannot carry authority from an earlier workspace attachment.
 */
export class DesktopAttachmentAccess {
  constructor(
    private readonly routes: Pick<WorkspaceSourceRoutes, 'referenceResources'>,
    private readonly roots: readonly {
      readonly name: string;
      readonly selectedDisk: Pick<FileSystemWorkspaceTextStore, 'validateAccess'>;
      readonly disk: Pick<FileSystemWorkspaceTextStore, 'validateAccess' | 'inspectDirectory'>;
      readonly index: Pick<WorkspacePathIndex, 'glob'>;
    }[],
    private readonly beginOperation: () => () => void,
  ) {}

  /** Revalidate captured paths before recording a message or handing its contents to the agent. */
  async admit(attachments: readonly GlyphContextAttachment[], signal: AbortSignal): Promise<void> {
    if (
      attachments.length > 32 ||
      attachments.reduce((total, item) => total + Buffer.byteLength(item.text), 0) > 2 * 1024 * 1024
    )
      throw new Error('Reduce the selected context to at most 32 attachments and 2 MiB.');
    const check = this.beginOperation();
    await Promise.all(
      attachments.map(async attachment => {
        const folder = attachment.kind === Kind.FOLDER;
        const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(attachment.uri)?.[1]?.toLowerCase();
        const { kind } = attachment;
        if (!Object.values(Kind).includes(kind) || attachment.unavailable || (attachment.folderListing && !folder))
          throw new Error('Unsupported attachment source.');
        if (
          (kind === Kind.TEST && (scheme === 'vscode-test-data' || scheme === 'glyph-test')) ||
          (kind === Kind.TERMINAL && scheme === 'glyph-terminal') ||
          (scheme === 'untitled' && [Kind.FILE, Kind.SELECTION, Kind.DIAGNOSTIC, Kind.SYMBOL].includes(kind))
        )
          return;
        // Early captures stored only their routed path. Resolve it through the current attachment's owner.
        const uri =
          !scheme && attachment.uri === attachment.path
            ? this.routes.referenceResources(attachment.path)[0]?.uri
            : attachment.uri;
        if (!uri || !/^file:/iu.test(uri) || kind === Kind.RULE) throw new Error('Unsupported attachment source.');
        const listing = await this.resolve(
          { uri, path: attachment.path, folder, projectFile: kind === Kind.SYMBOL || attachment.projectFile === true },
          signal,
        );
        if (kind === Kind.DIFF) {
          const related = this.diffSources(attachment.text);
          await Promise.all(
            related.map(source =>
              this.resolve({ ...source, folder: false, projectFile: attachment.projectFile === true }, signal),
            ),
          );
        }
        if (!listing) return;
        const captured = attachment.folderListing ?? historicalListing(attachment, listing);
        const visible = new Set(listing.files);
        if (
          captured.files.length > 1000 ||
          typeof captured.truncated !== 'boolean' ||
          captured.files.some(name => !visible.has(name)) ||
          attachment.text !== formatFolderAttachment(attachment.path, captured.files, captured.truncated)
        )
          throw new Error('The selected folder contents have changed. Refresh the attachment before sending.');
      }),
    );
    signal.throwIfAborted();
    check();
  }

  async resolve(resource: GlyphAttachmentResource, signal: AbortSignal): Promise<GlyphFolderListing | undefined> {
    signal.throwIfAborted();
    const check = this.beginOperation();
    const { uri, path, folder } = resource;
    const selected = fileURLToPath(uri);
    const single = this.roots.length === 1;
    const [rootName, ...parts] = path.split('/');
    const owner = single ? this.roots[0] : this.roots.find(root => root.name === rootName);
    if (!owner) throw new Error('The attachment workspace folder is unavailable.');
    const candidates = this.routes.referenceResources(path);
    if (!candidates.some(candidate => relative(fileURLToPath(candidate.uri), selected) === ''))
      throw new Error('The selected attachment does not belong to the declared workspace path.');
    const local = single ? path : parts.join('/');
    let listing: GlyphFolderListing | undefined;
    if (folder) {
      const directory = local === '.' || local === '' ? undefined : local;
      await owner.disk.inspectDirectory(directory);
      const result = await owner.index.glob('**/*', {
        limit: 1000,
        ...(directory && { targetDirectory: directory }),
        signal,
      });
      const prefix = directory ? directory + '/' : '';
      listing = {
        files: result.files.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)),
        truncated: result.truncated,
      };
      await owner.disk.inspectDirectory(directory);
    } else {
      await (resource.projectFile ? owner.disk : owner.selectedDisk).validateAccess(local);
    }
    if (storedSourcePath(selected) !== storedSourcePath(fileURLToPath(candidates[0]!.uri)))
      throw new Error('The selected attachment changed its workspace location.');
    signal.throwIfAborted();
    check();
    return listing;
  }

  /** Both new and historical Git captures record their original and modified resources in the comparison header. */
  private diffSources(text: string) {
    const match = /^Git diff: [^\n]*\nBase URI: ([^\n]*)\nTarget URI: ([^\n]*)\n/u.exec(text);
    if (!match) return [];
    return [match[1]!, match[2]!]
      .filter(value => value !== '/dev/null')
      .map(value => {
        const url = new URL(value);
        if (url.protocol !== 'file:' && url.protocol !== 'git:')
          throw new Error('Unsupported Git comparison resource.');
        const params: unknown =
          url.protocol === 'git:' && url.search ? JSON.parse(decodeURIComponent(url.search.slice(1))) : undefined;
        const repository = isRecord(params) && typeof params.submoduleOf === 'string' ? params.submoduleOf : undefined;
        if (isRecord(params) && typeof params.path === 'string' && !isAbsolute(params.path))
          throw new Error('Invalid Git comparison path.');
        const uri =
          isRecord(params) && typeof params.path === 'string'
            ? pathToFileURL(params.path).href
            : 'file://' + url.host + url.pathname;
        const physical = fileURLToPath(uri);
        for (const { name: root } of this.roots) {
          const single = this.roots.length === 1;
          for (const resource of this.routes.referenceResources(single ? '.' : root)) {
            const anchor = fileURLToPath(resource.uri);
            const name = relative(anchor, physical);
            if (!name || outside(name)) continue;
            if (
              repository &&
              (!isAbsolute(repository) ||
                outside(relative(anchor, repository)) ||
                outside(relative(repository, physical)))
            )
              continue;
            const route = name.split(sep).join('/');
            return { uri, path: single ? route : root + '/' + route };
          }
        }
        throw new Error('The Git comparison no longer belongs to this workspace.');
      });
  }
}

/** Older drafts retained the rendered outline only. Rebuild its subset exclusively from names admitted today. */
function historicalListing(attachment: GlyphContextAttachment, visible: GlyphFolderListing): GlyphFolderListing {
  if (attachment.text === formatFolderAttachment(attachment.path, visible.files, visible.truncated)) return visible;
  const lines = new Set(attachment.text.split('\n'));
  return {
    files: visible.files.filter(file =>
      formatFolderContextOutline([file])
        .split('\n')
        .every(line => lines.has(line)),
    ),
    truncated: attachment.text.endsWith('\n… Tree truncated at the search limit.'),
  };
}

function outside(path: string): boolean {
  return path === '..' || path.startsWith('..' + sep) || isAbsolute(path);
}
