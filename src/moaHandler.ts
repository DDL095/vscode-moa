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
import { runSingleIterationAnalyze, runMoaLoopAnalyze, type MoaFinalOutput } from "./moaOrchestrator";

/**
 * v0.16.0: 三种 chat 模式
 *   - 'loop'   → @moa / @moaloop：完整迭代，Aggregator 自然决策收敛
 *   - 'single' → @moasingle：单次 1 轮强制收敛（快速分析）
 */
type ChatMode = 'loop' | 'single';

/**
 * 共享的 chat 响应逻辑：三个入口（@moa / @moaloop / @moasingle）复用。
 */
async function runMoaChatEntry(
  mode: ChatMode,
  userPrompt: string,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const modeLabel = mode === 'loop' ? 'Loop (iterative)' : 'Single (1-shot)';
  stream.progress(`[MoA v0.17 ${mode === 'loop' ? 'Loop' : 'Single'}] starting 5-role pipeline (Planner → Recon → Refs → Aggregator → Actor)...`);

  const start = Date.now();
  try {
    const output: MoaFinalOutput & { task_id: string } = mode === 'loop'
      ? await runMoaLoopAnalyze(userPrompt, token, {
          progress: (msg) => stream.progress(msg),
          toolInvocationToken: request.toolInvocationToken,
        })
      : await runSingleIterationAnalyze(userPrompt, token, {
          progress: (msg) => stream.progress(msg),
          toolInvocationToken: request.toolInvocationToken,
        });

    // 显示最终 summary
    stream.markdown(output.summary);

    // 附加元信息（task_id + 落盘路径 + 置信度 + mode）
    const confPct = (output.confidence * 100).toFixed(0);
    stream.markdown(
      `\n\n---\n\n> **MoA v0.17 ${modeLabel}** | task_id: \`${output.task_id}\` | iterations: ${output.iterations_used} | confidence: ${confPct}%`
    );
    stream.markdown(`> 落盘文件：\`.moa_cache/${output.task_id}/final.md\` (完整报告) + \`timeline.md\` (时序表)`);
    stream.markdown(`> 中间过程：VSCode Output 面板下拉选择 MoA Planner / MoA Recon / MoA Refs / MoA Aggregator / MoA Actor`);

    // v0.16.0: 低 confidence 警告（loop 模式下说明任务真的难，single 模式下说明证据不足）
    if (output.confidence < 0.8) {
      if (mode === 'single') {
        stream.markdown(`\n> ⚠️ **Low confidence (${confPct}%)** — Single-shot mode forced finalize. Aggregator may have wanted more iterations. Try \`@moaloop\` for iterative refinement.`);
      } else {
        stream.markdown(`\n> ⚠️ **Low confidence (${confPct}%)** — Task did not reach 80% threshold even after ${output.iterations_used} iteration(s). Evidence may be genuinely incomplete.`);
      }
    }

    if (output.action_items.length > 0) {
      stream.markdown(`\n\n**Action Items:**`);
      for (const a of output.action_items) {
        stream.markdown(`\n- **[${a.type}]** ${a.target}`);
      }
    }

    const elapsed = (Date.now() - start) / 1000;
    stream.progress(`[MoA] done (${elapsed.toFixed(1)}s, ${mode})`);
    return {
      metadata: { mode, path: `5-role-${mode}`, elapsedSec: elapsed, task_id: output.task_id },
    };
  } catch (err) {
    // 新管线失败，fallback 到老路径 runP1Fanout（仅保留 single 模式的 fallback；
    // loop 模式 fallback 到单次老管线语义不一致，直接报错）
    const message = err instanceof Error ? err.message : String(err);
    stream.progress(`[MoA] 5-role ${mode} pipeline failed (${message.substring(0, 100)})...`);
    console.warn(`[@moa] 5-role ${mode} pipeline failed:`, err);

    if (mode === 'loop') {
      // loop 模式不 fallback（runP1Fanout 是单次语义，与 loop 不匹配）
      stream.markdown(`**[Error]** MoA Loop pipeline failed: ${message}\n\nTry \`@moasingle\` for a single-shot fallback.`);
      return {
        metadata: { mode, path: "error" },
        errorDetails: { message },
      };
    }

    // single 模式 fallback 到 runP1Fanout
    stream.progress(`[MoA] falling back to legacy runP1Fanout...`);
    try {
      const result = await runP1Fanout(
        userPrompt,
        stream,
        token,
        request.toolInvocationToken
      );
      stream.progress(`[MoA] done (${result.elapsed.toFixed(1)}s, ${result.path}, legacy fallback)`);
      return {
        metadata: { mode, path: result.path, elapsedSec: result.elapsed, fallback: true },
      };
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      stream.markdown(`**[Error]** MoA failed (both 5-role and legacy paths):\n\n- 5-role: ${message}\n- Legacy: ${fallbackMsg}`);
      return {
        metadata: { mode, path: "error" },
        errorDetails: { message: `5-role: ${message}; Legacy: ${fallbackMsg}` },
      };
    }
  }
}

/**
 * @moa — 默认 loop 模式（v0.16.0：原 v0.15 的单次语义改为 loop）
 */
export const moaHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
  const command = request.command ?? "";
  const userPrompt = request.prompt?.trim() ?? "";

  if (command === "help") {
    stream.markdown(buildHelpMarkdown());
    return { metadata: { command, path: "help" } };
  }

  if (!userPrompt) {
    stream.markdown(
      "**[MoA Bridge]** ready. Type `@moa <your question>` to start iterative multi-perspective analysis (Loop mode).\n\n" +
        "Other entries: `@moaloop` (explicit loop) · `@moasingle` (single-shot, faster but less thorough)\n\n" +
        "Setup: Command Palette → `Moa: Configure Models` to pick your reference advisors and aggregator."
    );
    return { metadata: { command, path: "noop" } };
  }

  // @moa 默认 loop
  return runMoaChatEntry('loop', userPrompt, request, stream, token);
};

/**
 * @moaloop — 显式 loop 模式（与 @moa 等价，名字更明确）
 */
export const moaLoopHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
  const userPrompt = request.prompt?.trim() ?? "";
  if (request.command === "help" || !userPrompt) {
    stream.markdown("**@moaloop** — Explicit Loop mode. Same as `@moa` (iterative until Aggregator naturally converges or MAX_ITER).");
    return { metadata: { path: "help" } };
  }
  return runMoaChatEntry('loop', userPrompt, request, stream, token);
};

/**
 * @moasingle — 显式单次模式（1 轮强制收敛，快速分析）
 */
export const moaSingleHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
  const userPrompt = request.prompt?.trim() ?? "";
  if (request.command === "help" || !userPrompt) {
    stream.markdown("**@moasingle** — Single-shot mode. Runs 1 iteration then forces finalize. Faster but Aggregator's actual suggestion may be `recon_needed` (evidence incomplete). For complex tasks, prefer `@moa` or `@moaloop`.");
    return { metadata: { path: "help" } };
  }
  return runMoaChatEntry('single', userPrompt, request, stream, token);
};

function buildHelpMarkdown(): string {
  return [
    "## MoA Bridge — Usage (v0.18.3)",
    "",
    "### 三种 chat 入口",
    "",
    "| 入口 | 模式 | 行为 | 适用场景 |",
    "|---|---|---|---|",
    "| `@moa <q>` | **Loop**（默认）| 完整迭代，Aggregator 自然决策收敛（直到 `finalize` 或 MAX_ITER=12）| 复杂分析、多文件重构、研究 |",
    "| `@moaloop <q>` | Loop | 同 `@moa`（显式写法）| 同上 |",
    "| `@moasingle <q>` | Single | 1 轮强制收敛（不论 Aggregator 建议）| 快速分析、简单查询 |",
    "",
    "### v0.16.0 confidence 真实性",
    "",
    "Confidence 统一用 `state.completeness`（Aggregator 在每轮迭代的真实评估）：",
    "- Loop 模式：自然收敛时的最终 completeness（通常 ≥80%）",
    "- Single 模式：第 1 轮的 completeness（可能 <80%，意味着证据不足，建议改用 Loop）",
    "",
    "timeline.md 的 Convergence Notes 会明确标注收敛来源：",
    "- `✅ Naturally converged` — Aggregator 决定 finalize",
    "- `🔄 Single-shot forced` — 单次模式强制（显示 Aggregator 原始建议）",
    "- `🛑 MAX_ITER forced` — 达到迭代上限",
    "- `⏸️ shouldStop forced` — 检测到停滞",
    "- `👤 Manual finalize` — 用户手动调 `#moa_finalize`",
    "",
    "### Setup",
    "",
    "Command Palette → `Moa: Configure Models` to pick reference advisors (multi-select) and aggregator (single-select).",
    "",
    "### 5 角色分工",
    "",
    "1. **Planner** — 拆解任务 + 给出 recon 方向（仅第 1 轮）",
    "2. **Recon** — 调工具收集证据（读文件/grep/web search 等）",
    "3. **Refs** — 多 LLM 并行分析（Hermes 风格）",
    "4. **Aggregator** — 综合 refs + Gate 决策（finalize / actor_needed / recon_needed）",
    "5. **Actor** — 执行 action_items（写文件/跑命令）",
    "",
    "**Slash command**: `@moa /help` — show this help",
    "",
    "**Configuration (settings.json)**:",
    "- `moa.refModels`: array of `{role, model}` where `model` is the unique `m.id` from vscode.lm.",
    "- `moa.aggregator`: `{model, temperature}` where `model` is also an `m.id`.",
    "- `moa.sharedRefPrompt`: optional override for the Hermes ref prompt (leave empty for built-in).",
    "- `moa.parallelRefs`: fan out refs in parallel (may cascade failures when subscriptions expire).",
  ].join("\n");
}