import type { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import { TerminalCapability } from '#vs/platform/terminal/common/capabilities/capabilities.js';
import { buildTestUri, parseTestUri, TestUriType } from '#vs/workbench/contrib/testing/common/testingUri.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { URI } from '#vs/base/common/uri.js';
import { CancellationTokenSource } from '#vs/base/common/cancellation.js';
import { Position } from '#vs/editor/common/core/position.js';
import { Range } from '#vs/editor/common/core/range.js';
import type { ICodeEditor } from '#vs/editor/browser/editorBrowser.js';
import type { ITextModel } from '#vs/editor/common/model.js';
import { ILanguageFeaturesService } from '#vs/editor/common/services/languageFeatures.js';
import { ITextModelService } from '#vs/editor/common/services/resolverService.js';
import { IMarkerService, MarkerSeverity, type IMarker } from '#vs/platform/markers/common/markers.js';
import { IQuickInputService } from '#vs/platform/quickinput/common/quickInput.js';
import { IWorkspaceTrustManagementService } from '#vs/platform/workspace/common/workspaceTrust.js';
import { ISCMService } from '#vs/workbench/contrib/scm/common/scm.js';
import { ITerminalService, type ITerminalInstance } from '#vs/workbench/contrib/terminal/browser/terminal.js';
import { ITestResultService } from '#vs/workbench/contrib/testing/common/testResultService.js';
import type { ITestRunTaskResults } from '#vs/workbench/contrib/testing/common/testResult.js';
import { isRecord } from '#glyph/protocol/isRecord.js';
import type { LocationLink } from '#vs/editor/common/languages.js';
import type { GlyphTextRange } from '#glyph/protocol/connection/GlyphTextRange.js';
import type { GlyphEditorAdapter } from './GlyphEditorAdapter.js';
import { GlyphContextError } from './GlyphContextError.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import {
  GlyphContextAttachmentKind as Kind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';

const limit = 512 * 1024;
const rangeOf = (range: Range) => ({
  start: { line: range.startLineNumber, column: range.startColumn },
  end: { line: range.endLineNumber, column: range.endColumn },
});
const digest = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

/** Explicit workbench captures. No repository history or language-service cache is searched implicitly. */
enum DiffChoice {
  STAGED = 'staged',
  UNSTAGED = 'unstaged',
}

const splitLines = (value: string) => (value ? value.replace(/\n$/u, '').split('\n') : []);

export class GlyphIdeContext {
  private readonly terminalCaptures = new Map<string, number>();
  constructor(
    private readonly adapter: GlyphEditorAdapter,
    @IMarkerService private readonly markers: IMarkerService,
    @ILanguageFeaturesService private readonly languages: ILanguageFeaturesService,
    @ITextModelService private readonly resolver: ITextModelService,
    @IQuickInputService private readonly quick: IQuickInputService,
    @ISCMService private readonly scm: ISCMService,
    @ITerminalService private readonly terminals: ITerminalService,
    @ITestResultService private readonly tests: ITestResultService,
    @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
  ) {}

  async select(editor: ICodeEditor | undefined): Promise<readonly GlyphContextAttachment[]> {
    this.assertTrusted();
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const choice = await this.quick.pick(
      [
        {
          label: 'Diagnostic',
          detail: 'Choose a reported problem and capture its source revision',
          kind: Kind.DIAGNOSTIC,
        },
        {
          label: 'Related symbols',
          detail: 'Definitions, references, and import declarations for selected code',
          kind: Kind.SYMBOL,
        },
        { label: 'Staged changes', detail: 'Explicit HEAD → index comparison for one file', kind: DiffChoice.STAGED },
        {
          label: 'Unstaged changes',
          detail: 'Explicit index → working tree comparison for one file',
          kind: DiffChoice.UNSTAGED,
        },
        { label: 'Terminal selection', detail: 'Only selected output from the active terminal', kind: Kind.TERMINAL },
        { label: 'Test output', detail: 'Choose a test run and output task', kind: Kind.TEST },
      ],
      { title: 'Attach IDE context to Glyph', placeHolder: 'Choose the context to capture' },
    );
    if (!choice) return [];
    switch (choice.kind) {
      case Kind.DIAGNOSTIC:
        return this.diagnostic(model ?? undefined);
      case Kind.SYMBOL:
        return model && selection
          ? this.symbols(model, selection)
          : this.fallback('Select code in an editor first.', model ?? undefined);
      case DiffChoice.STAGED:
      case DiffChoice.UNSTAGED:
        return this.diff(choice.kind === DiffChoice.STAGED, model ?? undefined);
      case Kind.TERMINAL:
        return this.terminal();
      case Kind.TEST:
        return this.testOutput();
      default:
        return [];
    }
  }

  async captureTestSelection(model: ITextModel, range: Range): Promise<GlyphContextAttachment> {
    this.assertTrusted();
    const parsed = parseTestUri(model.uri);
    const run = parsed === undefined ? undefined : this.tests.getResult(parsed.resultId);
    const task: ITestRunTaskResults | undefined =
      run === undefined || parsed === undefined ? undefined : run.tasks[parsed.taskIndex];
    if (run === undefined || task === undefined)
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'The originating test run is unavailable.');
    const version = model.getVersionId();
    const text = model.getValueInRange(range);
    return this.snapshot(
      Kind.TEST,
      {
        uri: model.uri.toString(),
        path: `Test output: ${task.name || run.name}`,
        range: rangeOf(range),
        sourceVersion: version,
        sourceRevision: `${run.id}:${task.id}:${version}`,
      },
      `Test run: ${run.name}\nRun ID: ${run.id}\nTask: ${task.name} (${task.id})\nController: ${task.ctrlId}\nEditor version: ${version}\nSelected lines: ${range.startLineNumber}-${range.endLineNumber}\n\nSelected test output:\n${text}`,
    );
  }

  async captureTestFailure(
    resultId: string,
    testId: string,
    taskIndex: number,
    messageIndex: number,
  ): Promise<readonly GlyphContextAttachment[]> {
    this.assertTrusted();
    const run = this.tests.getResult(resultId);
    const test = run?.getStateById(testId);
    const message = test?.tasks[taskIndex]?.messages[messageIndex];
    if (!run || !test || !message)
      throw new Error('The selected test failure is no longer available. Run the test again.');
    const uri = buildTestUri({ type: TestUriType.ResultMessage, resultId, testExtId: testId, taskIndex, messageIndex });
    const reference = await this.resolver.createModelReference(uri);
    try {
      const source = await this.captureTestSelection(
        reference.object.textEditorModel,
        reference.object.textEditorModel.getFullModelRange(),
      );
      const location = message.location;
      const details = `Test: ${test.item.label} (${testId})\nSource: ${location ? `${location.uri.toString()}:${location.range.startLineNumber}` : (test.item.uri?.toString() ?? 'unavailable')}\nRun state: ${run.completedAt === undefined ? 'running (partial)' : 'completed'}\n`;
      const comparison =
        'expected' in message || 'actual' in message
          ? `\nExpected: ${'expected' in message ? (typeof message.expected === 'string' ? message.expected : 'unavailable') : 'unavailable'}\nActual: ${'actual' in message ? (typeof message.actual === 'string' ? message.actual : 'unavailable') : 'unavailable'}\n`
          : '';
      return [await this.snapshot(Kind.TEST, source, details + comparison + '\n' + source.text)];
    } finally {
      reference.dispose();
    }
  }

  async openSource(uri: URI, editors: IEditorService, range?: GlyphTextRange): Promise<boolean> {
    if (uri.scheme === 'glyph-terminal') {
      const id = this.terminalCaptures.get(uri.toString());
      const instance = id === undefined ? undefined : this.terminals.getInstanceFromId(id);
      if (!instance)
        throw new GlyphContextError(
          GlyphDesktopErrorCode.NOT_FOUND,
          'Terminal closed. The captured output is preserved.',
        );
      this.terminals.setActiveInstance(instance);
      await this.terminals.revealActiveTerminal();
      await instance.focusWhenReady(true);
      return true;
    }
    if (uri.scheme === 'vscode-test-data') {
      const parsed = parseTestUri(uri);
      const run = parsed === undefined ? undefined : this.tests.getResult(parsed.resultId);
      const task: ITestRunTaskResults | undefined =
        run === undefined || parsed === undefined ? undefined : run.tasks[parsed.taskIndex];
      if (run === undefined || parsed === undefined || task === undefined)
        throw new GlyphContextError(
          GlyphDesktopErrorCode.NOT_FOUND,
          'Test run unavailable. The captured output is preserved.',
        );
      await editors.openEditor({
        resource: uri,
        options: {
          pinned: true,
          ...(range
            ? {
                selection: {
                  startLineNumber: range.start.line,
                  startColumn: range.start.column,
                  endLineNumber: range.end.line,
                  endColumn: range.end.column,
                },
              }
            : {}),
        },
      });
      return true;
    }
    if (uri.scheme === 'glyph-test') {
      const [runId, taskId] = uri.path
        .slice(1)
        .split('/')
        .map(value => decodeURIComponent(value));
      const run = this.tests.getResult(runId);
      const taskIndex = run?.tasks.findIndex(task => task.id === taskId) ?? -1;
      if (!run || taskIndex < 0)
        throw new GlyphContextError(
          GlyphDesktopErrorCode.NOT_FOUND,
          'Test run unavailable. The captured output is preserved.',
        );
      await editors.openEditor({
        resource: buildTestUri({ type: TestUriType.TaskOutput, resultId: runId, taskIndex }),
        options: {
          pinned: true,
          ...(range
            ? {
                selection: {
                  startLineNumber: range.start.line,
                  startColumn: range.start.column,
                  endLineNumber: range.end.line,
                  endColumn: range.end.column,
                },
              }
            : {}),
        },
      });
      return true;
    }
    return false;
  }

  async captureDiagnostic(marker: IMarker): Promise<readonly GlyphContextAttachment[]> {
    this.assertTrusted();
    const reference = await this.resolver.createModelReference(marker.resource);
    try {
      const current = reference.object.textEditorModel;
      const range = current.validateRange(
        new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
      );
      const source = await this.adapter.captureContext(current, rangeOf(range));
      const status =
        !this.markers.read({ resource: marker.resource }).includes(marker) ||
        (marker.modelVersionId !== undefined && marker.modelVersionId !== current.getVersionId())
          ? 'stale: diagnostic no longer matches the editor; captured message is historical'
          : marker.modelVersionId === undefined
            ? 'freshness unknown: provider did not report a model version'
            : 'current';
      return [
        await this.snapshot(
          Kind.DIAGNOSTIC,
          source,
          `Diagnostic (${status})\nSource: ${marker.source ?? marker.owner}\nSeverity: ${MarkerSeverity.toString(marker.severity)}\nLocation: ${source.path}:${marker.startLineNumber}:${marker.startColumn}-${marker.endLineNumber}:${marker.endColumn}\nEditor revision: ${source.sourceRevision}\nMessage: ${marker.message}\n\nCaptured source:\n${source.text}`,
        ),
      ];
    } finally {
      reference.dispose();
    }
  }

  async captureDiff(
    uri: URI,
    before: URI | undefined,
    after: URI | undefined,
    base: string,
    captured?: (before: string, after: string) => void,
  ): Promise<GlyphContextAttachment> {
    this.assertTrusted();
    const path = this.adapter.contextPath(uri.with({ query: '', fragment: '' }));
    const read = async (resource: URI | undefined) => {
      if (!resource) return '';
      if (!['file', 'git'].includes(resource.scheme))
        throw new GlyphContextError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE, 'Unsupported Git comparison resource.');
      this.adapter.contextPath(resource.with({ scheme: 'file', query: '', fragment: '' }));
      const reference = await this.resolver.createModelReference(resource);
      try {
        const target = reference.object.textEditorModel;
        if (target.getValueLength() > limit / 2)
          throw new GlyphContextError(GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED, 'Choose a smaller Git change.');
        return target.getValue();
      } finally {
        reference.dispose();
      }
    };
    const oldText = await read(before);
    const newText = await read(after);
    if (oldText !== (await read(before)) || newText !== (await read(after)))
      throw new GlyphContextError(
        GlyphDesktopErrorCode.STALE_DOCUMENT,
        'The Git comparison changed during capture. Capture it again.',
      );
    const text = `Git diff: ${base}\nBase URI: ${before?.toString() ?? '/dev/null'}\nTarget URI: ${after?.toString() ?? '/dev/null'}\nBase SHA-256: ${await digest(oldText)}\nTarget SHA-256: ${await digest(newText)}\n\n--- ${before ? path : '/dev/null'}\n+++ ${after ? path : '/dev/null'}\n${this.diffBody(oldText, newText)}`;
    captured?.(oldText, newText);
    return this.snapshot(Kind.DIFF, { uri: uri.with({ query: '', fragment: '' }).toString(), path }, text);
  }

  async terminal(
    terminal: ITerminalInstance | undefined = this.terminals.activeInstance,
  ): Promise<readonly GlyphContextAttachment[]> {
    this.assertTrusted();
    const text = terminal?.selection;
    if (!terminal || text === undefined || text === '')
      return this.fallback('Select terminal output before attaching it.');
    // Arbitrary selections can span commands; never attribute them to the last command by guesswork.
    const selection = terminal.xterm?.raw.getSelectionPosition();
    const commands = terminal.capabilities.get(TerminalCapability.CommandDetection)?.commands ?? [];
    const origins = commands.filter(
      command =>
        selection !== undefined &&
        command.marker !== undefined &&
        command.executedMarker !== undefined &&
        command.endMarker !== undefined &&
        command.executedMarker.line <= selection.start.y &&
        command.endMarker.line >= selection.end.y,
    );
    const command = origins.length === 1 ? origins[0] : undefined;
    const uri = `glyph-terminal:/${generateUuid()}/${terminal.instanceId}`;
    this.terminalCaptures.set(uri, terminal.instanceId);
    return [
      await this.snapshot(
        Kind.TERMINAL,
        { uri, path: `Terminal ${terminal.instanceId}: ${terminal.title}` },
        `Terminal: ${terminal.title}\nInstance: ${terminal.instanceId}\nCommand: ${command?.command ?? 'unavailable: selection cannot be attributed to one detected command'}\nWorking directory: ${command?.cwd ?? 'unavailable'}\nCaptured at: ${new Date().toISOString()}\n\nSelected output:\n${text}`,
      ),
    ];
  }

  private assertTrusted(): void {
    if (!this.trust.isWorkspaceTrusted())
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
        'Trust this workspace before attaching IDE context.',
      );
  }

  private async snapshot(
    kind: Kind,
    source: Pick<GlyphContextAttachment, 'uri' | 'path'> & Partial<GlyphContextAttachment>,
    text: string,
  ): Promise<GlyphContextAttachment> {
    this.assertTrusted();
    if (new TextEncoder().encode(text).byteLength > limit)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'This context exceeds 512 KiB. Select a smaller passage or output task.',
      );
    if (
      (source.uri.startsWith('file:') || source.uri.startsWith('untitled:')) &&
      this.adapter.contextPath(URI.parse(source.uri)) !== source.path
    )
      throw new GlyphContextError(GlyphDesktopErrorCode.STALE_DOCUMENT, 'The workspace changed during capture.');
    const contentRevision = await digest(text);
    this.assertTrusted();
    return { ...source, id: generateUuid(), kind, text, contentRevision };
  }

  private async fallback(message: string, model?: ITextModel): Promise<readonly GlyphContextAttachment[]> {
    const choice = await this.quick.pick(
      model && !model.isDisposed()
        ? [
            { label: 'Attach active file instead', detail: message, attach: true },
            { label: 'Cancel', attach: false },
          ]
        : [{ label: 'No context available', detail: message, attach: false }],
      { title: message },
    );
    return choice?.attach === true && model ? [await this.adapter.captureContext(model)] : [];
  }

  private async diagnostic(model?: ITextModel): Promise<readonly GlyphContextAttachment[]> {
    const items = this.markers
      .read()
      .filter(marker => {
        try {
          this.adapter.contextPath(marker.resource);
          return true;
        } catch {
          return false;
        }
      })
      .map(marker => ({
        label: marker.message,
        description: `${this.adapter.contextPath(marker.resource)}:${marker.startLineNumber}`,
        marker,
      }));
    if (items.length === 0)
      return this.fallback('No diagnostics are reported. Diagnostic support may be unavailable.', model);
    const chosen = await this.quick.pick(items, { title: 'Choose a diagnostic to attach', matchOnDescription: true });
    if (!chosen) return [];
    return this.captureDiagnostic(chosen.marker);
  }

  private async symbols(model: ITextModel, selection: Range): Promise<readonly GlyphContextAttachment[]> {
    const hasDefinitions = this.languages.definitionProvider.has(model);
    const hasReferences = this.languages.referenceProvider.has(model);
    if (!hasDefinitions && !hasReferences)
      return this.fallback('Language-service definitions and references are unavailable.', model);
    const source = await this.adapter.captureContext(model, rangeOf(selection));
    const version = source.token!.version;
    const cancellation = new CancellationTokenSource();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancellation.cancel();
    }, 5000);
    const positions: Position[] = [selection.getStartPosition()];
    const identifiers = new Set<string>();
    for (const match of source.text.slice(0, 4000).matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) {
      if (
        identifiers.has(match[0]) ||
        /^(?:import|from|as|const|let|var|function|class|export|default|return|if|else|new|type|interface|async|await|def|True|False|None)$/u.test(
          match[0],
        )
      )
        continue;
      identifiers.add(match[0]);
      positions.push(model.getPositionAt(model.getOffsetAt(selection.getStartPosition()) + match.index));
      if (positions.length >= 20) break;
    }
    const results: GlyphContextAttachment[] = [];
    const seen = new Set<string>();
    let omitted = 0;
    let unavailable = 0;
    // Discard in-flight results if the selected source changes during lookup.
    let changed = model.getVersionId() !== version;
    const watch = model.onDidChangeContent(() => {
      changed = true;
      cancellation.cancel();
    });
    if (changed) cancellation.cancel();
    try {
      for (const position of positions) {
        if (cancellation.token.isCancellationRequested) break;
        for (const relation of ['definition', 'reference'] as const) {
          if (relation === 'definition' ? !hasDefinitions : !hasReferences) continue;
          const queries =
            relation === 'definition'
              ? this.languages.definitionProvider.ordered(model).map(async provider => {
                  const value = await provider.provideDefinition(model, position, cancellation.token);
                  return !value ? [] : Array.isArray(value) ? value : [value];
                })
              : this.languages.referenceProvider
                  .ordered(model)
                  .map(
                    async provider =>
                      (await provider.provideReferences(
                        model,
                        position,
                        { includeDeclaration: true },
                        cancellation.token,
                      )) ?? [],
                  );
          const query: Promise<{ links: LocationLink[]; failures: number }> = Promise.allSettled(queries).then(
            settled => ({
              links: settled.flatMap(result => (result.status === 'fulfilled' ? result.value : [])),
              failures: settled.filter(result => result.status === 'rejected').length,
            }),
          );
          const { links, failures } = await new Promise<Awaited<typeof query>>(resolve => {
            const listener = cancellation.token.onCancellationRequested(() => {
              listener.dispose();
              resolve({ links: [], failures: 0 });
            });
            void query.then(value => {
              listener.dispose();
              resolve(value);
            });
            if (cancellation.token.isCancellationRequested) {
              listener.dispose();
              resolve({ links: [], failures: 0 });
            }
          });
          unavailable += failures;
          for (const link of links) {
            const range = link.targetSelectionRange ?? link.range;
            const key = `${link.uri.toString()}:${JSON.stringify(range)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (results.length >= 20) {
              omitted++;
              continue;
            }
            try {
              this.adapter.contextPath(link.uri);
            } catch {
              omitted++;
              continue;
            }
            const reference = await this.resolver.createModelReference(link.uri);
            try {
              const target = reference.object.textEditorModel;
              const targetVersion = target.getVersionId();
              const captured = await this.adapter.captureContext(target, rangeOf(Range.lift(link.range)));
              if (targetVersion !== target.getVersionId()) {
                changed = true;
                continue;
              }
              results.push(
                await this.snapshot(
                  Kind.SYMBOL,
                  captured,
                  `${relation}: ${captured.path}:${range.startLineNumber}:${range.startColumn}\nEditor revision: ${captured.sourceRevision}\n\n${captured.text}`,
                ),
              );
            } finally {
              reference.dispose();
            }
          }
        }
      }
      // Import declarations are explicitly labeled lexical context, not invented language-service results.
      if (
        !changed &&
        !model.isDisposed() &&
        /^(typescript|typescriptreact|javascript|javascriptreact|python)$/u.test(model.getLanguageId())
      ) {
        for (let line = 1; line <= model.getLineCount() && results.length < 24; line++) {
          const text = model.getLineContent(line);
          if (
            !/^\s*(?:import\b|from\b|(?:const|let|var)\b.*\brequire\s*\()/u.test(text) ||
            ![...identifiers].some(name => text.split(/[^\p{L}\p{N}_$]+/u).includes(name))
          )
            continue;
          const captured = await this.adapter.captureContext(
            model,
            rangeOf(new Range(line, 1, line, model.getLineMaxColumn(line))),
          );
          results.push(
            await this.snapshot(
              Kind.SYMBOL,
              captured,
              `Import declaration (lexical match): ${captured.path}:${line}\nEditor revision: ${captured.sourceRevision}\n\n${captured.text}`,
            ),
          );
        }
      }
      const stale = changed || model.isDisposed() || model.getVersionId() !== version;
      const status = stale
        ? 'stale: editor changed during lookup; related results omitted. Capture again to refresh.'
        : timedOut
          ? 'partial: language-service timeout'
          : unavailable
            ? 'partial: language-service queries failed'
            : 'captured from current language services';
      const summary = await this.snapshot(
        Kind.SYMBOL,
        source,
        `Related symbols (${status})\nDefinitions: ${hasDefinitions ? 'available' : 'unavailable'}; references: ${hasReferences ? 'available' : 'unavailable'}\n${omitted} results omitted by workspace or count limits; ${unavailable} failed queries. Up to 20 selected identifiers are queried.\nEditor revision: ${source.sourceRevision}\n\nSelected code:\n${source.text}`,
      );
      return [summary, ...(stale ? [] : results)];
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
      watch.dispose();
    }
  }

  private async diff(staged: boolean, model?: ITextModel): Promise<readonly GlyphContextAttachment[]> {
    const items = [...this.scm.repositories]
      .filter(repository => repository.provider.providerId === 'git')
      .flatMap(repository =>
        repository.provider.groups
          .filter(group => group.id === (staged ? 'index' : 'workingTree'))
          .flatMap(group =>
            group.resources.map(resource => ({
              label: this.adapter.contextPath(resource.sourceUri),
              description: repository.provider.name,
              resource,
            })),
          ),
      );
    if (items.length === 0)
      return this.fallback(
        'No matching Git changes are available. Git support or a repository may be unavailable.',
        model,
      );
    const chosen = await this.quick.pick(items, {
      title: staged ? 'Attach staged changes (HEAD → index)' : 'Attach unstaged changes (index → working tree)',
    });
    if (!chosen) return [];
    const resource = chosen.resource;
    let before = resource.multiDiffEditorOriginalUri;
    // Git's regular diff UI uses HEAD for some deleted/type-changed resources.
    // An explicit unstaged capture must compare the index, including staged edits.
    if (!staged && before?.scheme === 'git') {
      const parsed: unknown = JSON.parse(before.query);
      const query = isRecord(parsed) ? parsed : {};
      if (typeof query.submoduleOf !== 'string' || query.submoduleOf === '')
        before = before.with({ query: JSON.stringify({ ...query, ref: '' }) });
    }
    const after = resource.multiDiffEditorModifiedUri;
    if (!before && !after) return this.fallback('This Git provider does not expose explicit diff resources.', model);
    const base = staged ? 'HEAD → index' : 'index → working tree (includes unsaved editor text)';
    return [await this.captureDiff(resource.sourceUri, before, after, base)];
  }

  private diffBody(before: string, after: string): string {
    const oldLines = splitLines(before);
    const newLines = splitLines(after);
    const body = (value: string, prefix: string) =>
      splitLines(value)
        .map(line => `${prefix}${line}\n`)
        .join('') + (value && !value.endsWith('\n') ? '\\ No newline at end of file\n' : '');
    return `@@ -${oldLines.length > 0 ? 1 : 0},${oldLines.length} +${newLines.length > 0 ? 1 : 0},${newLines.length} @@\n${body(before, '-')}${body(after, '+')}`;
  }

  private async testOutput(): Promise<readonly GlyphContextAttachment[]> {
    const items = this.tests.results.flatMap(run =>
      run.tasks.map(task => ({
        label: task.name || run.name,
        description: run.name,
        detail: `Run ${run.id} · ${run.completedAt === undefined ? 'running (partial output)' : 'completed'}`,
        run,
        task,
      })),
    );
    if (items.length === 0)
      return this.fallback('Test output is unavailable. Run tests with a workbench test provider first.');
    const chosen = await this.quick.pick(items, { title: 'Choose test output to attach', matchOnDescription: true });
    if (!chosen) return [];
    const { run, task } = chosen;
    if (task.output.length > limit - 2048)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'This test output is too large. Select a passage in its output editor instead.',
      );
    const text = task.output.getRange(0, task.output.length).toString();
    return [
      await this.snapshot(
        Kind.TEST,
        {
          uri: `glyph-test:/${encodeURIComponent(run.id)}/${encodeURIComponent(task.id)}`,
          path: `Test output: ${task.name || run.name}`,
        },
        `Test run: ${run.name}\nRun ID: ${run.id}\nTask: ${task.name} (${task.id})\nController: ${task.ctrlId}\nState: ${run.completedAt === undefined ? 'running; partial output' : `completed at ${new Date(run.completedAt).toISOString()}`}\nCaptured at: ${new Date().toISOString()}\n\n${text}`,
      ),
    ];
  }
}
