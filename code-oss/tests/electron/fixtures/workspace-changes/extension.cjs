// Exercise the public workspace API. No Glyph services or private renderer hooks.
const vscode = require('vscode');
/** @param {import('vscode').ExtensionContext} context */
exports.activate = context => {
  context.subscriptions.push(
    vscode.commands.registerCommand('glyphFixture.addWorkspaceFolder', async () => {
      const path = await vscode.window.showInputBox({ prompt: 'Workspace folder path' });
      if (path !== undefined && path !== '')
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
          uri: vscode.Uri.file(path),
        });
    }),
  );
};
