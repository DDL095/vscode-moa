/**
 * MoA ChatRequestHandler — the brain of the @moa participant.
 *
 * v0.7.2: simplified. Only the P1 native path (vscode.lm) is wired up — the
 * P2a/P2b/detectPath/preset/scripts paths are all removed because they were
 * either unimplemented (P2a), unused (P2b needed Hermes which we replaced
 * with native in v0.3.0), or dead code (preset was parsed but ignored at
 * runtime).
 *
 * Lifecycle per request:
 *   1. Extract slash command (only `/help` is supported).
 *   2. Fan out refs via vscode.lm, aggregate, stream Markdown.
 *   3. Return ChatResult with metadata.
 */

import * as vscode from "vscode";
import { runP1Fanout } from "./moaRunner";

export const moaHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
  const command = request.command ?? "";
  const userPrompt = request.prompt?.trim() ?? "";

  // Slash command shortcut.
  if (command === "help") {
    stream.markdown(buildHelpMarkdown());
    return { metadata: { command, path: "help" } };
  }

  if (!userPrompt) {
    stream.markdown(
      "**[MoA Bridge]** ready. Type `@moa <your question>` to start a multi-perspective analysis.\n\n" +
        "Setup: Command Palette → `Moa: Configure Models` to pick your reference advisors and aggregator."
    );
    return { metadata: { command, path: "noop" } };
  }

  stream.progress("[MoA] starting (equal-mode, Hermes prompt)...");

  try {
    const result = await runP1Fanout(userPrompt, stream, token);
    stream.progress(`[MoA] done (${result.elapsed.toFixed(1)}s, ${result.path})`);
    return {
      metadata: { command, path: result.path, elapsedSec: result.elapsed },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stream.markdown(`**[Error]** MoA failed: ${message}`);
    return {
      metadata: { command, path: "error" },
      errorDetails: { message },
    };
  }
};

function buildHelpMarkdown(): string {
  return [
    "## MoA Bridge — Usage",
    "",
    "**Trigger**: `@moa <your question>`",
    "",
    "**Setup**: Command Palette → `Moa: Configure Models` to pick reference advisors (multi-select) and aggregator (single-select).",
    "",
    "**How it works (equal-mode MoA, Hermes style)**:",
    "1. All reference advisors share the same Hermes `_REFERENCE_SYSTEM_PROMPT` — diversity comes from model differences (e.g. GLM vs DeepSeek vs MiniMax), not role assignment.",
    "2. Each ref produces private advisory analysis (not a user-facing answer).",
    "3. The aggregator synthesizes the refs into the final response.",
    "",
    "**Slash command**: `@moa /help` — show this help",
    "",
    "**Configuration (settings.json)**:",
    "- `moa.refModels`: array of `{role, model}` where `model` is the unique `m.id` from vscode.lm (e.g. `gcmp.zhipu:::glm-5.2`).",
    "- `moa.aggregator`: `{model, temperature}` where `model` is also an `m.id`.",
    "- `moa.sharedRefPrompt`: optional override for the Hermes ref prompt (leave empty for built-in).",
    "- `moa.parallelRefs`: fan out refs in parallel (may cascade failures when subscriptions expire).",
  ].join("\n");
}