export function isEnumValue<T extends Record<string, string>>(values: T, value: string): value is T[keyof T] {
  return Object.values(values).includes(value);
}
