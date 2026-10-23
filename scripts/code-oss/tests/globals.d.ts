declare var glyphIdeQueries: {
  definition: (...args: unknown[]) => Promise<unknown>;
  reference: (...args: unknown[]) => Promise<unknown>;
};

type HarnessAction = (...args: unknown[]) => unknown;

interface ComposerHarness {
  calls: string[];
  captures: import('#src/desktop/protocol/connection/GlyphContextAttachment.ts').GlyphContextAttachment[][];
  steering: string[];
  menuActions: string[];
  setContextCandidates(files: { uri: string; path: string }[]): unknown;
  snapshot(): import('#src/desktop/workbench/GlyphComposerState.ts').GlyphComposerState['snapshot'];
  selectFiles(cancel?: boolean): unknown;
  attachSelection(): unknown;
  unmount(): unknown;
  mount(status?: string): unknown;
  reject(): unknown;
  resolve(): unknown;
}

interface Window {
  composerTest: ComposerHarness;
  glyphView: { update: HarnessAction; dispose(): void };
  glyphPreviewStage: string;
  actions: [string, string][];
  calls: unknown[][];
  changes: unknown[];
  clicks: unknown[];
  copies: unknown[];
  decisions: unknown[];
  openedLinks: unknown[];
  requests: unknown[];
  submits: unknown[];
  failCopy: boolean;
  failure?: string;
  clock: number;
  showGoal: HarnessAction;
  injected: unknown;
  pwned?: unknown;
  buildDiagram: (tree: unknown) => string;
  messageNode: unknown;
  opened: unknown;
  acknowledge: HarnessAction;
  approval: HarnessAction;
  configure: HarnessAction;
  disconnect: HarnessAction;
  fail: HarnessAction;
  finish: HarnessAction;
  finishBranch: HarnessAction;
  inspectFixtures: HarnessAction;
  newChat: HarnessAction;
  show: HarnessAction;
  showApproval: HarnessAction;
  showAttachment: HarnessAction;
  showComposer: HarnessAction;
  showMarkdown: HarnessAction;
  showMessageActions: HarnessAction;
  showWorkbench: HarnessAction;
  showTranscript: HarnessAction;
  showWorkbenchStory: HarnessAction;
  update: HarnessAction;
}
