import { describe, expect, it } from 'vitest';
import { parseGoalCommand } from '#src/desktop/workbench/parseGoalCommand.js';

describe(parseGoalCommand, () => {
  it.each([
    ['/goal Make CI green', 'Make CI green'],
    ['  /goal   Make CI green  ', 'Make CI green'],
    ['/goal Fix the build\nthen ship it', 'Fix the build\nthen ship it'],
  ])('extracts the objective from %j', (text, objective) => {
    expect(parseGoalCommand(text)).toBe(objective);
  });

  it.each(['/goal', '/goal   '])('reports an empty objective for %j', text => {
    expect(parseGoalCommand(text)).toBe('');
  });

  it.each(['Make CI green', '/goals Make CI green', 'Please /goal Make CI green', '/goalMake CI green'])(
    'leaves ordinary messages alone: %j',
    text => {
      expect(parseGoalCommand(text)).toBeUndefined();
    },
  );
});
