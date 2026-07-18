/**
 * MoA Bridge — extension entry point.
 *
 * Registers the `@moa` chat participant and wires up its icon.
 */

import * as vscode from 'vscode';
import { moaHandler } from './moaHandler';

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
      // Default followups; the handler can also return its own per-request list.
      return [
        { prompt: 'preset=fast 再试一次', label: '⚡ Fast preset' } as vscode.ChatFollowup,
        { prompt: 'preset=academic 再试一次', label: '🎓 Academic preset' } as vscode.ChatFollowup,
      ];
    },
  };

  context.subscriptions.push(participant);

  // Friendly activation log (visible in Extension Host output).
  console.log('[moa-bridge] @moa participant registered (id=' + PARTICIPANT_ID + ')');
}

export function deactivate(): void {
  // No persistent state to clean up — chat participant disposal is handled by VSCode.
  console.log('[moa-bridge] deactivated');
}