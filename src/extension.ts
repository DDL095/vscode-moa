/**
 * MoA Bridge — extension entry point.
 *
 * Registers the `@moa` chat participant and wires up its icon.
 */

import * as vscode from 'vscode';
import { moaHandler } from './moaHandler';
import { configureModels, listAvailableModels, testModels } from './moaConfig';

const PARTICIPANT_ID = 'moa-bridge.moa';

export function activate(context: vscode.ExtensionContext): void {
  // Create the chat participant.
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, moaHandler);

  // Use the media icon if present, otherwise a built-in fallback.
  const iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'moa-icon.png');
  participant.iconPath = iconPath;

  // Optional: surface an "I am MoA" badge while processing.
  participant.followupProvider = {
    provideFollowups(
      _result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.ChatFollowup[]> {
      return [
        { prompt: 'preset=fast 再试一次', label: 'Fast preset' } as vscode.ChatFollowup,
        { prompt: 'preset=academic 再试一次', label: 'Academic preset' } as vscode.ChatFollowup,
      ];
    },
  };

  context.subscriptions.push(participant);

  // ---------- Commands (accessible via Command Palette) ----------
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.configureModels', configureModels),
    vscode.commands.registerCommand('moa.listModels', listAvailableModels),
    vscode.commands.registerCommand('moa.testModels', testModels)
  );

  console.log('[moa-bridge] @moa participant registered (id=' + PARTICIPANT_ID + ')');
  console.log('[moa-bridge] commands registered: moa.configureModels, moa.listModels, moa.testModels');
}

export function deactivate(): void {
  // No persistent state to clean up — chat participant disposal is handled by VSCode.
  console.log('[moa-bridge] deactivated');
}