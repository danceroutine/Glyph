export function createNullPrototypeRecord<T>(): Record<string, T>;
export function createNullPrototypeRecord(): unknown {
  const record: unknown = Object.create(null);
  return record;
}
