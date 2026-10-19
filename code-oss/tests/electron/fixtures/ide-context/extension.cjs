// Deterministic language/test providers at the extension-host boundary. Glyph's
// workbench adapters, editor models, attachment UI, host and persistence stay real.
const vscode = require('vscode');
exports.activate = context => {
  let slow = false;
  context.subscriptions.push(
    vscode.commands.registerCommand('glyphFixture.slowSymbols', () => {
      slow = true;
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('glyph-fixture', {
      async provideDefinition(document) {
        if (slow) await new Promise(resolve => setTimeout(resolve, 1500));
        return new vscode.Location(document.uri, new vscode.Range(0, 0, 0, 5));
      },
    }),
  );
  const controller = vscode.tests.createTestController('glyph-fixture-tests', 'Glyph fixture tests');
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('glyphFixture.testOutput', () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'slow.glyph');
      const test = controller.createTestItem('capture-case', 'Capture case', uri);
      test.range = new vscode.Range(0, 0, 0, 5);
      controller.items.add(test);
      const run = controller.createTestRun(new vscode.TestRunRequest([test]), 'Deterministic output run');
      run.started(test);
      run.appendOutput('FIRST TEST OUTPUT\r\nselected evidence\r\n');
      const message = new vscode.TestMessage('Deliberate fixture failure');
      message.location = new vscode.Location(uri, test.range);
      run.failed(test, message);
      run.end();
    }),
  );
};
