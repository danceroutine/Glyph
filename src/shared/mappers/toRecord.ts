import { ProtocolError } from '#src/errors/ProtocolError.js';
import { isRecord } from '#src/shared/validators/isRecord.js';

export function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError('Unexpected server response shape.');
  return value;
}
