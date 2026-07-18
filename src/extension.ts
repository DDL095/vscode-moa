/**
 * MoA Bridge — extension entry point.
 *
 * Registers the `@moa` chat participant and wires up its icon.
 */

import * as vscode from 'vscode';
import { moaHandler } from './moaHandler';
import { configureModels } from './moaConfig';

const PARTICIPANT_ID = 'moa-bridge.moa';

export function activate(context: vscode.ExtensionContext): void {
  // Create the chat participant.
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, moaHandler);

  // Use the media icon if present, otherwise a built-in fallback.
  const iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'moa-icon.png');
  participant.iconPath = iconPath;

  // No followupProvider — preset feature was removed in v0.7.2 (never actually
  // worked: parsePrompt extracted preset name but runP1Fanout ignored it).

  context.subscriptions.push(participant);

  // ---------- Commands (accessible via Command Palette) ----------
  // v0.7.1: trimmed to 1 command. List/Probe/ProbeAll all removed — the user
  // does precise model selection via Configure Models, which shows all
  // available models in its checkbox picker anyway.
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.configureModels', configureModels)
  );

  console.log('[moa-bridge] @moa participant registered (id=' + PARTICIPANT_ID + ')');
  console.log('[moa-bridge] command registered: configureModels');
}

export function deactivate(): void {
  // No persistent state to clean up — chat participant disposal is handled by VSCode.
  console.log('[moa-bridge] deactivated');
}