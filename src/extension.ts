/**
 * MoA Bridge — extension entry point.
 *
 * Registers:
 *   - The `@moa` chat participant (v0.1.0+)
 *   - The `moa_analyze` LM tool (v0.10.0) — subagent-style entry point
 *
 * v0.10.0: The `moa_analyze` tool is what makes MoA "Hermes-style" — any
 * LLM (including the main Copilot Chat) can decide to call it for hard
 * questions, and receive the full multi-model result as a tool result.
 * This means users no longer need to type `@moa` explicitly; the main LLM
 * can route the request through MoA automatically.
 */

import * as vscode from 'vscode';
import { moaHandler } from './moaHandler';
import { configureModels, switchPreset } from './moaConfig';
import { migrateLegacyToPreset } from './presetConfig';
import { probeTools } from './probeTools';
import { registerMoaAnalyzeTool } from './moaTool';
import { registerMoaReconTool } from './moaReconTool';
import { registerMoaOrchestrateTools } from './moaOrchestrateTools';

const PARTICIPANT_ID = 'moa-bridge.moa';

// v0.12.0 diagnostic: persistent OutputChannel so activation errors are visible
// even if activate() throws midway.
let _diagChannel: vscode.OutputChannel | undefined;
function diag(): vscode.OutputChannel {
  if (!_diagChannel) {
    _diagChannel = vscode.window.createOutputChannel('MoA Bridge Diag');
  }
  return _diagChannel;
}

export function activate(context: vscode.ExtensionContext): void {
  const startedAt = new Date().toISOString();
  diag().appendLine(`[MoA activate] enter @ ${startedAt}`);
  diag().appendLine(`[MoA activate] vscode.lm keys: ${Object.keys(vscode.lm).join(', ')}`);
  diag().appendLine(`[MoA activate] vscode.lm.registerTool type: ${typeof (vscode.lm as any).registerTool}`);
  diag().appendLine(`[MoA activate] vscode.lm.tools length (before register): ${vscode.lm.tools.length}`);

  try {
    // Create the chat participant.
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, moaHandler);

    // Use the media icon if present, otherwise a built-in fallback.
    const iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'moa-icon.png');
    participant.iconPath = iconPath;

    context.subscriptions.push(participant);
    diag().appendLine('[MoA activate] chat participant registered');

    // v0.11.0: Register moa_recon + moa_analyze as LM tools (Hermes subagent pattern).
    registerMoaReconTool(context);
    diag().appendLine('[MoA activate] moa_recon registered OK');

    registerMoaAnalyzeTool(context);
    diag().appendLine('[MoA activate] moa_analyze registered OK');

    // v0.12.0: Register iterative orchestration tools (moa_orchestrate / _continue / _finalize).
    registerMoaOrchestrateTools(context);
    diag().appendLine('[MoA activate] moa_orchestrate/continue/finalize registered OK');

    diag().appendLine(`[MoA activate] vscode.lm.tools length (after register): ${vscode.lm.tools.length}`);

    // Verify our tools are in the runtime list
    const ourTools = vscode.lm.tools.filter((t) => t.name.startsWith('moa_'));
    diag().appendLine(`[MoA activate] our tools visible in vscode.lm.tools: ${ourTools.length}`);
    if (ourTools.length > 0) {
      for (const t of ourTools) {
        diag().appendLine(`  - ${t.name}`);
      }
    } else {
      diag().appendLine('  ❌ NONE — registerTool call succeeded but tools not in runtime list!');
      diag().appendLine('  This suggests VSCode 1.129 may require proposedApi or different API name.');
    }

    // ---------- Commands (accessible via Command Palette) ----------
    context.subscriptions.push(
      vscode.commands.registerCommand('moa.configureModels', configureModels),
      vscode.commands.registerCommand('moa.switchPreset', switchPreset),
      vscode.commands.registerCommand('moa.probeTools', probeTools)
    );

    // v0.14.14: Auto-migrate legacy flat config → presets.default (idempotent).
    // Fire-and-forget — runs in background, logs to diag channel on completion.
    migrateLegacyToPreset()
      .then((migrated) => {
        if (migrated) {
          diag().appendLine(
            `[MoA activate] v0.14.14 auto-migration: legacy flat config → presets.default (OK)`
          );
          vscode.window.showInformationMessage(
            'MoA Bridge v0.14.14: Your existing model configuration was migrated to the "default" preset group. Use "MoA: Switch Preset" to manage multiple groups.'
          );
        } else {
          diag().appendLine(
            `[MoA activate] v0.14.14 auto-migration: no legacy config or already migrated (skip)`
          );
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        diag().appendLine(`[MoA activate] v0.14.14 auto-migration FAILED: ${msg}`);
      });

    console.log('[moa-bridge] @moa participant registered (id=' + PARTICIPANT_ID + ')');
    console.log('[moa-bridge] tool registered: moa_analyze');
    console.log('[moa-bridge] command registered: configureModels, switchPreset');
    diag().appendLine('[MoA activate] complete OK');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? '' : '';
    diag().appendLine(`[MoA activate] ❌ FAILED: ${msg}`);
    if (stack) diag().appendLine(stack);
    diag().show(true);
    throw err;  // re-throw so VSCode marks the extension as activation-failed
  }
}

export function deactivate(): void {
  console.log('[moa-bridge] deactivated');
}