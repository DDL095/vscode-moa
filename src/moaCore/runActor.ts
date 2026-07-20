/**
 * moaCore/runActor.ts — v0.15.0 Actor 角色（执行 action_items）
 *
 * 职责：执行 Aggregator 给出的 action_items（write_file / execute / create_roadmap）。
 * 调用时机：Aggregator 标记 next_action="actor_needed" 时。
 *
 * 设计哲学：
 *   - 全工具权限（readFile/writeFile/run_in_terminal/fetch_webpage/grep/...）
 *   - 复用 src/actingAgent.ts 的 runActingAgent（write-mode loop）
 *   - 失败不阻塞流程（记录 error_message，下一轮 Recon 调查）
 *   - research_more 类型的 action_item 跳过（留给下轮 Recon）
 */

import * as vscode from 'vscode';
import {
  buildActorPrompt,
  ActorResult,
  ActorActionResult,
  AggregatorOutput,
} from './roles';
import { getActivePresetConfig } from '../presetConfig';
import { runActingAgent } from '../actingAgent';
// v0.19.1 §3: SafeExecutor（保守执行模式）
import { createSafeExecutor } from './safeExecutor';

/**
 * v0.19.0 §1: Actor 调用 actingAgent 时的最大迭代数。
 *
 * 提取为常量是为了：
 *   1. actingAgent.ts §1.1 注入"强制 JSON 总结"消息时，能感知到这个值
 *      （通过 options.maxIterations 传入，actingAgent 内部 maxIter 变量）
 *   2. runActor.ts §1.2 兜底分支引用此值，构造"Hit iteration cap (N/M)"消息
 *
 * 选 15 而非默认 12（MAX_ACTING_ITERATIONS）：Actor 可能需要多轮工具调用
 * （读文件 → 分析 → 写文件 → 跑测试 → 验证），每轮 LLM 可发起多个 tool call。
 */
const ACTOR_MAX_ITERATIONS = 15;

/**
 * 解析 Actor 模型（fallback 到 aggregator）。
 */
async function resolveActorModel(): Promise<vscode.LanguageModelChat> {
  const all = await vscode.lm.selectChatModels({});
  const PLACEHOLDER = new Set(['auto', 'automatic', 'default', '']);
  const real = all.filter((m) => !PLACEHOLDER.has(m.name.toLowerCase().trim()));

  const activePreset = getActivePresetConfig();
  if (activePreset.isEmpty) {
    throw new Error('No preset configured.');
  }

  // 优先：actor 显式配置
  const actorCfg = activePreset.actor;
  if (actorCfg?.model && actorCfg.model.trim().length > 0) {
    const m = real.find((x) => (x.id ?? '') === actorCfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(actorCfg.model.toLowerCase()));
    if (m) return m;
  }

  // Fallback：aggregator
  const aggCfg = activePreset.aggregator;
  if (aggCfg?.model) {
    const m = real.find((x) => (x.id ?? '') === aggCfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(aggCfg.model.toLowerCase()));
    if (m) return m;
  }

  if (real.length > 0) return real[0];
  throw new Error('No usable model for Actor.');
}

/**
 * v0.15.0 主入口：调用 Actor 角色。
 *
 * @param task               任务描述
 * @param actionItems        Aggregator 给出的 action_items
 * @param iteration          当前 iteration
 * @param token              取消令牌
 * @param progress           进度回调
 * @param stream             chat stream
 * @param toolInvocationToken  工具调用 token
 */
export async function callActor(
  params: {
    task: string;
    actionItems: NonNullable<AggregatorOutput['action_items']>;
    iteration: number;
    /**
     * v0.19.1 §3: 任务目录（.moa_cache/<task_id>/），用于 SafeExecutor
     * 写 manifest.json 和 _trash/。可选（不传则不启用保守执行模式）。
     */
    taskDir?: string;
  },
  token: vscode.CancellationToken,
  progress?: (msg: string) => void,
  stream?: vscode.ChatResponseStream,
  toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<ActorResult> {
  const start = Date.now();

  try {
    const model = await resolveActorModel();
    progress?.(`[MoA Actor] iteration ${params.iteration}, model=${model.name}, ${params.actionItems.length} action(s)`);

    const { system, user } = buildActorPrompt(params);
    // Acting agent 的接口是 (model, aggregatorGuidance, userPrompt, ...)
    // 我们把 Actor 的 system prompt 作为 aggregatorGuidance 注入
    const combinedPrompt = system + '\n\n=== ORIGINAL USER QUESTION ===\n' + params.task;

    const actingStream = stream ?? createProgressOnlyStream(progress);

    // v0.19.1 §3: SafeExecutor（保守执行模式）
    //
    // 仅当以下条件全部满足时启用：
    //   1. params.taskDir 存在（moaOrchestrator 传入）
    //   2. moa.safeExecutionMode 配置为 true（默认 true）
    //
    // 启用后，所有 tool calls 会经过 SafeExecutor 拦截：
    //   - write_file / delete 类：预备份 + manifest 记录
    //   - execute 类：仅 manifest 记录
    //   - read / grep / other：仅 manifest 记录
    const safeModeEnabled = vscode.workspace.getConfiguration('moa').get<boolean>('safeExecutionMode', true);
    const safeExecutor = (params.taskDir && safeModeEnabled)
      ? createSafeExecutor(params.taskDir, params.iteration, progress)
      : undefined;
    if (safeExecutor) {
      progress?.(`[MoA Actor] SafeExecutor enabled (manifest will be written to ${params.taskDir}/manifest.json)`);
    }

    // 使用默认 acting agent prompt（不传 systemPrompt override）
    // 把 Actor 的指令通过 aggregatorGuidance 注入
    const result = await runActingAgent(
      model,
      combinedPrompt,    // aggregatorGuidance: Actor 的执行指令
      user,              // userPrompt: action_items 列表
      toolInvocationToken,
      actingStream,
      token,
      {
        readOnly: false,    // 全工具权限
        maxIterations: ACTOR_MAX_ITERATIONS,
        progressPrefix: 'MoA Actor',
        // v0.19.0 §1.2: 改为 true，以便撞 iteration cap 时兜底能从
        // capturedToolCalls 构造 partial executed_actions。
        // 代价：内存占用增加（保留所有 tool result 文本）。
        // 好处：Layer 2 bug 下 LLM 不输出 JSON 时仍有可审计证据。
        captureToolResults: true,
        // v0.19.1 §3: SafeExecutor（保守执行模式）
        safeExecutor,
      }
    );

    // v0.19.1 §3: iter 结束后 flush manifest
    if (safeExecutor) {
      try {
        await safeExecutor.flushManifest();
        const records = safeExecutor.getRecords();
        if (records.length > 0) {
          progress?.(`[MoA Actor] SafeExecutor: ${records.length} action(s) recorded to manifest.json`);
        }
      } catch (err) {
        progress?.(`[MoA Actor] SafeExecutor flushManifest failed: ${err instanceof Error ? err.message.substring(0, 100) : String(err)}`);
      }
    }

    const elapsed = (Date.now() - start) / 1000;
    progress?.(`[MoA Actor] done in ${elapsed.toFixed(1)}s, ${result.iterations} iterations, ${result.toolCallsSucceeded}/${result.toolCallsSucceeded + result.toolCallsFailed} tool calls OK`);

    // 从 acting agent 的 finalOutput 解析 JSON（Actor 应输出 JSON）
    let executedActions: ActorActionResult[] = [];
    let selfAssessment = {
      all_succeeded: result.toolCallsFailed === 0,
      missing_dependencies: [] as string[],
      should_recon: false,
      reason: result.hitIterationCap ? 'Hit iteration cap' : 'Actor completed',
    };

    if (result.output) {
      try {
        // 尝试从 finalOutput 提取 JSON
        const parsed = extractActorJson(result.output);
        if (parsed?.executed_actions && Array.isArray(parsed.executed_actions)) {
          executedActions = parsed.executed_actions;
        }
        if (parsed?.self_assessment) {
          selfAssessment = {
            all_succeeded: parsed.self_assessment.all_succeeded ?? selfAssessment.all_succeeded,
            missing_dependencies: Array.isArray(parsed.self_assessment.missing_dependencies)
              ? parsed.self_assessment.missing_dependencies
              : [],
            should_recon: parsed.self_assessment.should_recon ?? false,
            reason: parsed.self_assessment.reason ?? selfAssessment.reason,
          };
        }
      } catch {
        // acting agent 输出不是 JSON，把整个 output 作为单条 action 的 output
        executedActions = [{
          action: {
            type: 'inform_user',
            target: 'actor_output',
            content: result.output,
            rationale: 'Actor did not produce structured JSON; raw output preserved.',
          },
          status: result.error ? 'failed' : 'success',
          output_chars: result.output.length,
          error_message: result.error,
          artifacts: [],
        }];
      }
    } else if (result.hitIterationCap && executedActions.length === 0
               && result.capturedToolCalls && result.capturedToolCalls.length > 0) {
      // ── v0.19.0 §1.2: 兜底 —— LLM 撞 iteration cap 且未输出 JSON 时，
      // 从 capturedToolCalls 构造最小 executed_actions，避免完全空跑 ──────
      // 背景：Layer 2 bug —— actingAgent 主循环撞 cap 时 finalOutput 是空字符串，
      //      上面的 result.output 分支不会被进入，executed_actions 保持空数组。
      //      v0.19.0 §1.1 在 actingAgent 最后一轮注入"强制 JSON 总结"，但 LLM
      //      仍可能不服从（继续调用工具）。本兜底确保即使 LLM 不输出 JSON，
      //      Actor 也至少有 1 条 partial executed_action，保留已做的工作证据。
      const toolSummary = result.capturedToolCalls
        .map((c, i) => {
          const inputShort = JSON.stringify(c.input).substring(0, 120);
          const resultShort = c.resultText.substring(0, 300);
          return `${i + 1}. ${c.name}(${inputShort})\n   → ${resultShort}`;
        })
        .join('\n\n');
      const partialContent = `Actor hit iteration cap (${result.iterations}/${ACTOR_MAX_ITERATIONS}). ` +
        `LLM did not produce structured JSON summary. ` +
        `Preserving ${result.capturedToolCalls.length} captured tool call(s) as partial progress:\n\n${toolSummary}`;
      executedActions = [{
        action: {
          type: 'inform_user',
          target: 'partial_progress',
          content: partialContent,
          rationale: 'LLM hit iteration cap without producing JSON; partial progress preserved from capturedToolCalls (v0.19.0 §1.2 fallback).',
        },
        status: 'partial',
        output_chars: partialContent.length,
        error_message: `Hit iteration cap (${result.iterations}/${ACTOR_MAX_ITERATIONS}) without producing JSON summary`,
        artifacts: result.capturedToolCalls.map((c) => c.name),
      }];
      progress?.(`[MoA Actor] §1.2 fallback: constructed ${executedActions.length} partial action(s) from ${result.capturedToolCalls.length} captured tool calls`);
    }

    return {
      executed_actions: executedActions,
      self_assessment: selfAssessment,
      elapsed_sec: elapsed,
      tool_calls: result.toolCallsSucceeded + result.toolCallsFailed,
      error: result.error,
    };
  } catch (err) {
    const elapsed = (Date.now() - start) / 1000;
    const msg = err instanceof Error ? err.message : String(err);
    progress?.(`[MoA Actor] CRITICAL failure in ${elapsed.toFixed(1)}s: ${msg.substring(0, 100)}`);
    return {
      executed_actions: [],
      self_assessment: {
        all_succeeded: false,
        missing_dependencies: [],
        should_recon: true,
        reason: `Actor crashed: ${msg}`,
      },
      elapsed_sec: elapsed,
      tool_calls: 0,
      error: msg,
    };
  }
}

/**
 * 宽松的 JSON 提取（Actor 输出可能含 markdown fence 或 prose）。
 */
function extractActorJson(text: string): {
  executed_actions?: ActorActionResult[];
  self_assessment?: {
    all_succeeded?: boolean;
    missing_dependencies?: string[];
    should_recon?: boolean;
    reason?: string;
  };
} | null {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(t.substring(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * 进度-only stream shim（与 runRecon.ts 一致）。
 */
function createProgressOnlyStream(
  progress?: (msg: string) => void
): vscode.ChatResponseStream {
  const shim = {
    markdown(_msg: string) { /* 静默 */ },
    progress(msg: string) { progress?.(msg); },
  };
  return shim as unknown as vscode.ChatResponseStream;
}
