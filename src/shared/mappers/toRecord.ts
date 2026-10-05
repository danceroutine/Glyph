import { ProtocolError } from '../../errors/ProtocolError.ts';

export function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('Unexpected server response shape.');
  }
  return value as Record<string, unknown>;
}
