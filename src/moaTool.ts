/**
 * MoA Analyze Tool (v0.10.0) — subagent-style entry point.
 *
 * Registers a `vscode.lm` tool called `moa_analyze` so any LLM (including the
 * main Copilot Chat session) can hand off a question to the full MoA pipeline
 * (recon → ref fan-out → aggregator → acting agent) and receive the synthesized
 * result as a tool result.
 *
 * Why this exists (Hermes-style orchestration):
 *   - The @moa chat participant requires the user to type `@moa` prefix.
 *   - Without that prefix, the main LLM takes over and tries to answer directly
 *     (and fails on tool calls without a proper toolInvocationToken → 1213).
 *   - With `moa_analyze` registered as an LM tool, the main LLM sees it in
 *     `vscode.lm.tools` and can DECIDE to call it for hard questions.
 *   - The result comes back via `vscode.LanguageModelToolResult`, which the
 *     main LLM integrates naturally into its final response.
 *
 * Activation: package.json declares `onLanguageModelTool:moa_analyze` so the
 * extension activates lazily when the tool is first referenced.
 *
 * Tool input schema:
 *   {
 *     "prompt": string,                  // The question/task (required)
 *     "forceDirect": boolean?,           // Skip ref/aggregator (default false)
 *     "includeReconSummary": boolean?    // Include recon summary in result (default false)
 *   }
 *
 * Tool result:
 *   A single Markdown text part containing the aggregated output.
 *   When `includeReconSummary=true`, the result also includes the recon
 *   summary so the main LLM has direct access to the collected file contents.
 */

import * as vscode from 'vscode';
import { EXTENSION_VERSION } from './extension';
import type { MoaRunResult } from './types';

// Re-use the P1 fanout logic from moaRunner. Note: we can't pass a
// ChatResponseStream (this is a tool, not a chat participant), so we use a
// minimal stream shim.
interface ProgressStreamShim {
  progress(msg: string): void;
  markdown(msg: string): void;
}

export class MoaAnalyzeTool implements vscode.LanguageModelTool<{
  prompt: string;
  forceDirect?: boolean;
  collectRawFiles?: boolean;
  maxReconRounds?: number;
  /**
   * v0.10.2: Pre-collected context (e.g. file contents, grep results) that
   * the calling LLM has already gathered. When provided, MoA skips its
   * internal recon phase and uses this directly as the ref prompt's
   * "RECON DATA" block. This enables the Hermes-style subagent flow:
   *   1. Main LLM reads file(s) via copilot_readFile
   *   2. Main LLM calls moa_analyze with reconContext=<file contents>
   *   3. MoA refs see the pre-gathered context without needing Phase 0
   */
  reconContext?: string;
  /**
   * Optional: list of file paths that produced the reconContext. Displayed
   * in the OutputChannel log for traceability.
   */
  reconSources?: string[];
}> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
      prompt: string;
      forceDirect?: boolean;
      collectRawFiles?: boolean;
      maxReconRounds?: number;
      reconContext?: string;
      reconSources?: string[];
    }>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const promptPreview = options.input.prompt.length > 80
      ? options.input.prompt.substring(0, 77) + '...'
      : options.input.prompt;
    const parts: string[] = [
      `Running MoA multi-perspective analysis on: "${promptPreview}"`,
    ];
    if (options.input.forceDirect) parts.push('(forceDirect mode — single model)');
    if (options.input.reconContext) {
      const ctxLen = options.input.reconContext.length;
      parts.push(`(using ${ctxLen} chars of pre-collected reconContext — skipping Phase 0)`);
    }
    if (options.input.collectRawFiles) parts.push('(will return collected file contents alongside the answer)');
    if (options.input.maxReconRounds !== undefined) {
      parts.push(`(max ${options.input.maxReconRounds} recon round(s))`);
    }
    return {
      invocationMessage: parts.join(' '),
      confirmationMessages: {
        title: 'MoA multi-perspective analysis',
        // TODO v0.13.0: switch message to MarkdownString once @types/vscode 1.128+ available
        message:
          `Run MoA pipeline (recon → ref fan-out → aggregator → acting agent) for: "${promptPreview}"?\n\n` +
          `This will invoke multiple LLMs and may take 30s-2min depending on configured refs.`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      prompt: string;
      forceDirect?: boolean;
      collectRawFiles?: boolean;
      maxReconRounds?: number;
      reconContext?: string;
      reconSources?: string[];
    }>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { prompt, forceDirect, collectRawFiles, maxReconRounds, reconContext, reconSources } = options.input;

    // Stream shim: route progress to the LLM via progress callback if available.
    const streamShim: ProgressStreamShim = {
      progress: (msg) => {
        if (options.toolInvocationToken) {
          console.log(`[moa_analyze progress] ${msg}`);
        }
      },
      markdown: (_msg) => {
        // Tools don't stream markdown to the user. We collect the final
        // output and return it as a tool result instead.
      },
    };

    // v0.15.0 批次 2: 默认走 5 角色单次流程（Planner → Recon → Refs → Aggregator → Actor）
    // forceDirect=true 或 maxReconRounds 显式指定时，回退到老路径 runP1Fanout
    const useNewPipeline = !forceDirect && maxReconRounds === undefined;

    if (useNewPipeline) {
      try {
        const { runSingleIterationAnalyze } = await import('./moaOrchestrator');
        const output = await runSingleIterationAnalyze(prompt, token, {
          reconContext,
          reconSources,
          progress: (msg) => streamShim.progress(msg),
          toolInvocationToken: options.toolInvocationToken,
        });

        let resultText = output.summary;
        // 附加 task_id + 落盘文件路径，方便用户查阅
        resultText += `\n\n---\n\n> **MoA v${EXTENSION_VERSION} Single-shot** | task_id: \`${output.task_id}\` | iterations: ${output.iterations_used} | confidence: ${(output.confidence * 100).toFixed(0)}%`;
        resultText += `\n> 落盘文件：\`.moa_cache/${output.task_id}/final.md\` (完整报告) + \`timeline.md\` (时序表)`;
        resultText += `\n> 中间过程：VSCode Output 面板下拉选择 MoA Planner / MoA Recon / MoA Refs / MoA Aggregator / MoA Actor`;

        if (collectRawFiles) {
          resultText +=
            `\n\n---\n\n` +
            `> **Tip**: For raw file contents collected during recon, call the ` +
            `\`moa_recon\` tool with the same prompt.`;
        }

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(resultText),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 新管线失败时自动 fallback 到老路径 runP1Fanout
        console.warn(`[moa_analyze] 5-role pipeline failed (${msg}), falling back to legacy runP1Fanout`);
        streamShim.progress(`[MoA Analyze] 5-role pipeline failed, falling back to legacy path: ${msg.substring(0, 100)}`);
        // 继续走下面的老路径
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Legacy path: runP1Fanout（forceDirect=true / maxReconRounds 指定 / 新管线失败时）
    // ─────────────────────────────────────────────────────────────────────

    // If the caller asks for specific recon behavior, override config for
    // this call only. Reset after.
    const config = vscode.workspace.getConfiguration('moa');
    const savedForceDirect = config.get<boolean>('forceDirect');
    const savedMaxRounds = config.get<number>('maxReconRounds');

    try {
      if (forceDirect !== undefined) {
        await config.update('forceDirect', forceDirect, vscode.ConfigurationTarget.Global);
      }
      if (maxReconRounds !== undefined) {
        await config.update('maxReconRounds', maxReconRounds, vscode.ConfigurationTarget.Global);
      }

      // Lazy-load to avoid circular imports.
      const { runP1Fanout, setCallerReconContext } = await import('./moaRunner');

      // v0.10.2: When caller provided reconContext, we need a way to inject
      // it. Since runP1Fanout does its own Phase 0 recon, we use a flag
      // (moa.enableRecon=false) to skip it, then pass the pre-collected
      // context through to refs via a module-level variable (v0.12.4 fix:
      // previously used config.update('callerReconContext') which fails on
      // VSCode 1.90+ because the key isn't declared in package.json).
      if (reconContext && reconContext.trim().length > 0) {
        const sources = reconSources?.join(', ') || 'caller-supplied';
        console.log(`[moa_analyze] using pre-collected reconContext: ${reconContext.length} chars from ${sources}`);
        // Disable internal recon since caller already gathered context.
        await config.update('enableRecon', false, vscode.ConfigurationTarget.Global);
        // Pass via module-level setter (no config key needed).
        setCallerReconContext(reconContext, reconSources ?? []);
      }

      const result: MoaRunResult = await runP1Fanout(
        prompt,
        streamShim as unknown as vscode.ChatResponseStream,
        token,
        options.toolInvocationToken
      );

      // Build the tool result.
      let resultText = result.output;
      if (collectRawFiles) {
        resultText +=
          `\n\n---\n\n` +
          `> **Tip**: For raw file contents collected during recon, call the ` +
          `\`moa_recon\` tool with the same prompt.`;
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(resultText),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `MoA pipeline failed: ${msg}\n\n` +
          `Troubleshooting:\n` +
          `- Check moa.refModels / moa.aggregator are configured (run "Moa: Configure Models")\n` +
          `- Verify subscription hasn't expired\n` +
          `- Try forceDirect=true for single-model fallback`
        ),
      ]);
    } finally {
      // Restore config (best-effort; ignore failures).
      try {
        if (forceDirect !== undefined) {
          await config.update('forceDirect', savedForceDirect ?? false, vscode.ConfigurationTarget.Global);
        }
        if (maxReconRounds !== undefined) {
          await config.update('maxReconRounds', savedMaxRounds ?? 3, vscode.ConfigurationTarget.Global);
        }
        if (reconContext && reconContext.trim().length > 0) {
          // Restore enableRecon and clear module-level recon context.
          const origEnable = config.get<boolean>('enableRecon') ?? true;
          await config.update('enableRecon', origEnable, vscode.ConfigurationTarget.Global);
          // Clear the module-level variable.
          const { setCallerReconContext } = await import('./moaRunner');
          setCallerReconContext('', []);
        }
      } catch {
        // Best-effort reset.
      }
    }
  }
}

/**
 * Register the moa_analyze tool. Should be called from extension.activate.
 */
export function registerMoaAnalyzeTool(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool('moa_analyze', new MoaAnalyzeTool())
  );
  console.log('[moa-bridge] tool registered: moa_analyze');
}