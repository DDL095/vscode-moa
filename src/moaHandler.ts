/**
 * MoA ChatRequestHandler — the brain of the @moa participant.
 *
 * Lifecycle per request:
 *   1. Parse prompt → extract preset + slash command.
 *   2. Detect execution path (P1 / P2a / P2b) from filesystem.
 *   3. Dispatch to the right runner (P1 native / P2b wrapper).
 *   4. Stream progress + final Markdown into the chat response stream.
 *   5. Surface followup suggestions and metadata.
 */

import * as vscode from 'vscode';
import { detectPath, parsePrompt, runMoaWrapper, runP1Fanout } from './moaRunner';

export const moaHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
  const { presetName, userPrompt, command } = parsePrompt(
    request.prompt,
    request.command ?? ''
  );

  // Slash command shortcuts.
  if (command === 'help') {
    stream.markdown(buildHelpMarkdown());
    return { metadata: { command, preset: presetName, path: 'help' } };
  }

  if (!userPrompt && command !== 'preset') {
    stream.markdown(
      '🌀 **MoA Bridge** is ready. Type `@moa <your question>` to start a multi-perspective analysis.\n\n' +
        'Tip: prefix with `preset=<name>` to pick a preset, e.g. `@moa preset=fast 分析 ...`.'
    );
    return { metadata: { command, preset: presetName, path: 'noop' } };
  }

  stream.progress(`🎯 MoA 启动（preset=${presetName}）…`);

  const detection = await detectPath();
  stream.progress(`📍 Path=${detection.path} (scripts: ${detection.scriptsDir || 'n/a'})`);

  try {
    if (detection.path === 'P2b') {
      stream.progress('🔄 调用 Hermes MoA（P2b wrapper）…');
      const result = await runMoaWrapper(
        userPrompt || '(empty prompt)',
        presetName,
        detection,
        stream,
        token
      );
      stream.progress(`✅ MoA 完成（${result.elapsed.toFixed(1)}s）`);
      return {
        metadata: { command, preset: result.preset, path: result.path, elapsedSec: result.elapsed },
      };
    }

    if (detection.path === 'P1' || detection.path === 'unknown') {
      // P1 path uses vscode.lm models — works even if no PowerShell scripts present.
      stream.progress('🔄 Fan-out via vscode.lm (P1 native)…');
      const result = await runP1Fanout(userPrompt, presetName, stream, token);
      stream.progress(`✅ MoA 完成（${result.elapsed.toFixed(1)}s, ${result.path}）`);
      return {
        metadata: { command, preset: result.preset, path: result.path, elapsedSec: result.elapsed },
      };
    }

    // P2a — ACP — not implemented in skeleton.
    stream.markdown(
      `⚠️ **P2a (ACP protocol) detected but not implemented in v0.1.0 skeleton.**\n\n` +
        `Please install the Hermes CLI and use **P2b** instead, or fall back to **P1** (native).\n\n` +
        `Detected scripts: \`${detection.scriptsDir}\``
    );
    return {
      metadata: { command, preset: presetName, path: detection.path },
      errorDetails: { message: 'P2a path not implemented in skeleton' },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ **MoA 失败**：${message}`);
    return {
      metadata: { command, preset: presetName, path: detection.path },
      errorDetails: { message },
    };
  }
};

// NOTE: Followups are surfaced via `participant.followupProvider` (configured
// in extension.ts). The handler itself returns plain ChatResult without a
// `followups` field — that field doesn't exist on ChatResult in @types/vscode.

function buildHelpMarkdown(): string {
  return [
    '## 🌉 MoA Bridge — Usage',
    '',
    '**Trigger**: `@moa <your prompt>`',
    '',
    '**Optional preset**: prefix with `preset=<name>` — available presets live in `moa-bridge/presets/` (`default`, `fast`, `academic`, `custom`).',
    '',
    '**Slash commands**:',
    '- `@moa /preset preset=<name> ...` — switch preset',
    '- `@moa /help` — show this help',
    '',
    '**Execution paths** (auto-detected):',
    '- **P2b** — call `MoaWrapper.ps1` via `pwsh` (recommended when Hermes is installed)',
    '- **P1** — native subagent simulation using `vscode.lm.selectChatModels`',
    '- **P2a** — ACP protocol (skeleton stub; needs formulahendry.acp-client)',
    '',
    '**Limitations (v0.1.0 skeleton)**:',
    '- P2a path is not implemented',
    '- No streaming token-level progress from `vscode.lm` (only per-model turn boundaries)',
    '- No preset hot-reload — restart the extension after editing `presets/*.json`',
  ].join('\n');
}