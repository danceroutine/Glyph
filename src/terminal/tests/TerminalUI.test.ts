import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import { TerminalUI } from '../TerminalUI.ts';

class MemoryOutput extends Writable {
  readonly isTTY: boolean;
  value = '';

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += String(chunk);
    callback();
  }
}

describe(TerminalUI, () => {
  describe(TerminalUI.prototype.push, () => {
    it('renders reasoning summaries as a subdued section before assistant text', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(true);
      const errors = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, errors);
      const previousNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;

      try {
        ui.beginAssistantResponse();
        ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'Inspected ' });
        ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'the project.' });
        ui.push({ type: ChatResponsePartType.TEXT, value: 'The answer.' });
      } finally {
        ui.close();
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }

      expect(output.value).toBe(
        '\u001b[2;90mthinking> \u001b[0m'
        + '\u001b[2;90mInspected \u001b[0m'
        + '\u001b[2;90mthe project.\u001b[0m'
        + '\nassistant> The answer.',
      );
      expect(errors.value).toBe('');
    });

    it('does not emit color control sequences when output is not a terminal', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.beginAssistantResponse();
      ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'Summary.' });
      ui.push({ type: ChatResponsePartType.TEXT, value: 'Answer.' });
      ui.close();

      expect(output.value).toBe('thinking> Summary.\nassistant> Answer.');
    });
  });
});
