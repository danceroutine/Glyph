import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import { ToolActivityPhase } from '../../chat/ToolActivityPhase.ts';
import { TerminalActionType } from '../TerminalActionType.ts';
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
  describe(TerminalUI.prototype.nextAction, () => {
    it('uses a prominent user prompt', async () => {
      const input = new PassThrough();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const previousNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;

      try {
        const action = ui.nextAction(new AbortController().signal);
        input.write('hello\n');

        await expect(action).resolves.toEqual({ type: TerminalActionType.SEND, prompt: 'hello' });
        expect(output.value).toContain('\u001b[1;36myou> \u001b[0m');
      } finally {
        ui.close();
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }
    });
  });

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
        + '\n\n\u001b[1;32massistant> \u001b[0m'
        + '\u001b[32mThe answer.\u001b[0m',
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

      expect(output.value).toBe('thinking> Summary.\n\nassistant> Answer.');
    });

    it('renders structured tool errors with their diagnostic details', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: {
          phase: ToolActivityPhase.COMPLETED,
          namespace: 'project',
          name: 'propose_patch',
          callId: 'call',
          arguments: 'patch',
          output: JSON.stringify({
            error: {
              code: 'AMBIGUOUS',
              message: 'Patch context matches more than one location.',
              path: 'src/App.tsx',
              candidates: [2, 8],
              retry: 'Include more unique context.',
            },
          }),
        },
      });
      ui.close();

      expect(output.value).toBe(
        '[tool< project.propose_patch error: AMBIGUOUS: Patch context matches more than one location. '
        + '(path=src/App.tsx; candidates=2, 8; retry=Include more unique context.)]\n',
      );
    });

    it('gives tool calls a distinct hierarchy and outcome color', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const previousNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;

      try {
        ui.push({
          type: ChatResponsePartType.TOOL,
          activity: {
            phase: ToolActivityPhase.STARTED,
            namespace: 'project',
            name: 'propose_patch',
            callId: 'call',
            arguments: '*** Begin Patch\n*** End Patch\n',
          },
        });
        ui.push({
          type: ChatResponsePartType.TOOL,
          activity: {
            phase: ToolActivityPhase.COMPLETED,
            namespace: 'project',
            name: 'propose_patch',
            callId: 'call',
            arguments: '',
            output: '{"status":"STAGED_FOR_REVIEW"}',
          },
        });
      } finally {
        ui.close();
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }

      expect(output.value).toBe(
        '\u001b[33m[tool> project.propose_patch]\u001b[0m\n'
        + '\u001b[2m  *** Begin Patch\n  *** End Patch\u001b[0m\n'
        + '\u001b[32m[tool< project.propose_patch completed]\u001b[0m\n',
      );
    });
  });
});
