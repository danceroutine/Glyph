import type { EditingConfiguration } from './EditingConfiguration.ts';

/** A base can exceed the result by removed text and an encoding BOM absent from the text diff. */
export function getEditingReadBudget(configuration: EditingConfiguration): number {
  const budget = configuration.maxResultingBytesPerFile + configuration.maxChangedBytes + 3;
  if (!Number.isSafeInteger(budget) || budget < 3) throw new Error('Editing read budget must be a safe integer.');
  return budget;
}
