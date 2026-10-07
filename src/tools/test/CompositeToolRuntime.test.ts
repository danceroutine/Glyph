import { describe, expect, it, vi } from 'vitest';
import { ToolInputKind } from '../ToolInputKind.ts';
import type { ToolRuntime } from '../ToolRuntime.ts';
import { CompositeToolRuntime } from '../CompositeToolRuntime.ts';

describe(CompositeToolRuntime, () => {
  describe('constructor', () => {
    it('combines definitions in runtime order', () => {
      const first = runtime('first');
      const second = runtime('second');

      expect(new CompositeToolRuntime([first, second]).definitions).toEqual([
        first.definitions[0],
        second.definitions[0],
      ]);
    });

    it('rejects duplicate names because provider callbacks identify tools by name', () => {
      expect(() => new CompositeToolRuntime([runtime('same'), runtime('same', 'another')])).toThrow(
        'Tool names must be globally unique: same',
      );
    });
  });

  describe(CompositeToolRuntime.prototype.execute, () => {
    it('dispatches the call and cancellation signal to the owning runtime', async () => {
      const owner = runtime('owned');
      const signal = new AbortController().signal;
      const composite = new CompositeToolRuntime([runtime('other'), owner]);

      await expect(composite.execute('owned', 'input', signal)).resolves.toBe('owned:input');
      expect(owner.execute).toHaveBeenCalledWith('owned', 'input', signal);
    });

    it('rejects unknown tools', async () => {
      const composite = new CompositeToolRuntime([]);

      await expect(composite.execute('missing', '{}')).rejects.toThrow('Unknown tool: missing');
    });
  });
});

function runtime(name: string, namespace = 'test'): ToolRuntime {
  return {
    definitions: [{ namespace, name, description: name, inputKind: ToolInputKind.JSON }],
    execute: vi.fn(async (_name, input) => `${name}:${input}`),
  };
}
