import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('tkroll.open', () => vscode.commands.executeCommand('tkroll.chat.focus')),
    vscode.commands.registerCommand('tkroll.openInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('tkroll.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('tkroll.setApiKey', () => provider.promptApiKey()),
    vscode.commands.registerCommand('tkroll.addSelection', () => provider.addActiveSelection()),
    vscode.commands.registerCommand('tkroll.addFile', (uri?: vscode.Uri) => provider.addFileUri(uri)),
    provider
  );
}

export function deactivate(): void {}
