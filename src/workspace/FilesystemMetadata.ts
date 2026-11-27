import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/** Access checks validate ACLs and inheritance. Replacement checks also protect secondary data streams. */
export interface FilesystemMetadata {
  inspect(handle: FileHandle, purpose: 'access' | 'replaceable'): Promise<void>;
}

export async function inspectFileMetadata(
  metadata: FilesystemMetadata,
  path: string,
  purpose: 'access' | 'replaceable',
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await metadata.inspect(handle, purpose);
  } finally {
    await handle.close();
  }
}
