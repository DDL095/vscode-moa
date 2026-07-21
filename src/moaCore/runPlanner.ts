/**
 * moaCore/runPlanner.ts — Planner 角色(任务理解 + 规划 + 角色设计师)
 *
 * v0.15.0: 单次调用 Planner
 * v0.22.0 P0-1: 升级为可迭代 mini-loop(默认 5 次,最大 20 次,plan_coverage 0.9 收敛)
 *              + role_setup 输出(为下游 3 角色定制身份)
 *              + MoA 入口类型感知
 *
 * 调用时机:orchestrate 首轮(iteration 0),仅一次(mini-loop 内部多次,但对外一次)。
 *
 * 设计哲学(对齐 docs/planner-system-prompt-v2.md):
 *   - Planner 是**智能路由 + 角色设计师**,不是简单的任务拆解器
 *   - mini-loop 自迭代是核心能力(needs_replan 默认 true)
 *   - 失败 fallback 到 v0.21.x 单次模式(向后兼容)
 *   - Refs/Aggregator 完全不可定制(架构红线)
 */

import * as vscode from 'vscode';
import { buildPlannerPrompt, extractJson, PlannerOutput } from './roles';
import { getActivePresetConfig } from '../presetConfig';

/**
 * v0.22.0 P0-1: mini-loop 配置(从 moa.* 配置项读取)。
 */
interface PlannerMiniLoopConfig {
  /** 启用 mini-loop(默认 true)。false = v0.21.x 单次行为 */
  enableIteration: boolean;
  /** mini-loop 最大迭代数(默认 5,最大 20) */
  maxIterations: number;
  /** plan_coverage 收敛阈值(默认 0.9) */
  coverageThreshold: number;
  /** 是否允许 Planner 调 read-only 工具(默认 true) */
  allowTools: boolean;
}

/** 读取 mini-loop 配置。 */
function readMiniLoopConfig(): PlannerMiniLoopConfig {
  const cfg = vscode.workspace.getConfiguration('moa');
  return {
    enableIteration: cfg.get<boolean>('enablePlannerIteration') ?? true,
    maxIterations: Math.min(20, Math.max(1, cfg.get<number>('plannerMaxIterations') ?? 5)),
    coverageThreshold: Math.min(1.0, Math.max(0.5, cfg.get<number>('plannerCoverageThreshold') ?? 0.9)),
    allowTools: cfg.get<boolean>('plannerAllowTools') ?? true,
  };
}

/**
 * 解析 Planner 模型（fallback 到 aggregator）。
 */
async function resolvePlannerModel(): Promise<vscode.LanguageModelChat> {
  const all = await vscode.lm.selectChatModels({});
  const PLACEHOLDER = new Set(['auto', 'automatic', 'default', '']);
  const real = all.filter((m) => !PLACEHOLDER.has(m.name.toLowerCase().trim()));

  const activePreset = getActivePresetConfig();
  if (activePreset.isEmpty) {
    throw new Error('No preset configured. Run "Moa: Configure Models".');
  }

  // 优先：planner 显式配置
  const plannerCfg = activePreset.planner;
  if (plannerCfg?.model && plannerCfg.model.trim().length > 0) {
    const m = real.find((x) => (x.id ?? '') === plannerCfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(plannerCfg.model.toLowerCase()));
    if (m) return m;
  }

  // Fallback：aggregator
  const aggCfg = activePreset.aggregator;
  if (aggCfg?.model) {
    const m = real.find((x) => (x.id ?? '') === aggCfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(aggCfg.model.toLowerCase()));
    if (m) return m;
  }

  // 最终 fallback：第一个可用模型
  if (real.length > 0) return real[0];
  throw new Error('No usable model for Planner.');
}

/**
 * 单次 Planner LLM 调用(支持 v0.21.x 或 v0.22 模板)。
 *
 * @param userPrompt     用户原始任务
 * @param model          已解析的 Planner 模型
 * @param token          取消令牌
 * @param options        v0.22 mini-loop 状态(可选,不传走 v0.21.x)
 */
async function callPlannerOnce(
  userPrompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  options?: {
    v22?: boolean;
    iteration?: number;
    prevCoverage?: number;
    entryType?: string;
    systemContextText?: string;
    fewShotsText?: string;
  }
): Promise<PlannerOutput> {
  const { system, user } = buildPlannerPrompt(userPrompt, options);
  const messages = [
    vscode.LanguageModelChatMessage.User(system + '\n\n---\n\n' + user),
  ];

  const response = await model.sendRequest(messages, {}, token);
  let raw = '';
  for await (const chunk of response.text) {
    raw += chunk;
  }

  const parsed = extractJson<PlannerOutput>(raw);

  // 防御性 normalize:确保数组字段是数组 + 新字段默认值
  const result: PlannerOutput = {
    clarified_task: parsed.clarified_task || userPrompt,
    sub_questions: Array.isArray(parsed.sub_questions) ? parsed.sub_questions.slice(0, 5) : [],
    recon_hints: Array.isArray(parsed.recon_hints) ? parsed.recon_hints.slice(0, 8) : [],
    expected_output_format: parsed.expected_output_format || 'analysis',
    difficulty: parsed.difficulty || 'moderate',
    needs_iteration: typeof parsed.needs_iteration === 'boolean' ? parsed.needs_iteration : true,
    // v0.22 新字段(可选,LLM 未输出时用默认值)
    task_type: parsed.task_type,
    process_language: parsed.process_language,
    plan_coverage: typeof parsed.plan_coverage === 'number'
      ? Math.min(1.0, Math.max(0, parsed.plan_coverage))
      : (options?.v22 ? 0.5 : 1.0),  // v0.22 默认 0.5(未收敛);v0.21.x 默认 1.0(已收敛)
    needs_replan: typeof parsed.needs_replan === 'boolean' ? parsed.needs_replan : (options?.v22 ? true : false),
    ask_user: typeof parsed.ask_user === 'boolean' ? parsed.ask_user : false,
    ask_user_questions: Array.isArray(parsed.ask_user_questions) ? parsed.ask_user_questions.slice(0, 3) : [],
    role_setup: parsed.role_setup,
  };

  return result;
}

/**
 * 调用 Planner。
 *
 * v0.21.x: 单次调用(若 moa.enablePlannerIteration=false 或 LLM 调用失败时 fallback)。
 * v0.22.0 P0-1: mini-loop(默认 5 次,最大 20 次,plan_coverage >= 0.9 收敛)。
 *
 * @param userPrompt         用户原始任务
 * @param token              取消令牌
 * @param progress           进度回调
 * @param options.entryType  MoA 入口类型(@moa/@moaloop/@moasingle/moa_analyze/moa_orchestrate)
 * @param options.systemContextText  基础设施层注入(由 systemContext.ts 生成)
 * @param options.fewShotsText       用户自定义 few-shot(从 Role Setup Preset 加载)
 * @returns PlannerOutput,失败时返回 undefined(调用方走 fallback)
 */
export async function runPlanner(
  userPrompt: string,
  token: vscode.CancellationToken,
  progress?: (msg: string) => void,
  options?: {
    entryType?: string;
    systemContextText?: string;
    fewShotsText?: string;
  }
): Promise<PlannerOutput | undefined> {
  const start = Date.now();
  const config = readMiniLoopConfig();
  const entryType = options?.entryType ?? '@moa';
  const systemContextText = options?.systemContextText ?? '';
  const fewShotsText = options?.fewShotsText ?? '';

  try {
    const model = await resolvePlannerModel();
    progress?.(`[MoA Planner] using ${model.name} (v0.22 mini-loop: ${config.enableIteration ? 'enabled' : 'disabled'})`);

    // ── v0.21.x 兼容路径:disableIteration=false → 单次调用简洁模板 ──
    if (!config.enableIteration) {
      const result = await callPlannerOnce(userPrompt, model, token);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      progress?.(`[MoA Planner] done in ${elapsed}s (v0.21.x single-call mode, difficulty=${result.difficulty})`);
      return result;
    }

    // ── v0.22 mini-loop ──
    // 收敛判据(三选一):
    //   A) plan_coverage >= coverageThreshold → needs_replan=false 自然收敛
    //   B) iteration >= maxIterations → 强制收敛 + 末尾标注 "(planner 未完全收敛)"
    //   C) ask_user=true → 询问用户(P0-8 实施 UI;P0-1 阶段先返回 ask_user 字段给上层)
    //
    // 绝对上限:iteration >= 20(防无限循环)
    const ABSOLUTE_MAX = 20;
    const effectiveMax = Math.min(config.maxIterations, ABSOLUTE_MAX);
    const coverageHistory: number[] = [];
    let lastResult: PlannerOutput | undefined;

    for (let iter = 1; iter <= effectiveMax; iter++) {
      if (token.isCancellationRequested) {
        progress?.(`[MoA Planner] cancelled at iteration ${iter}`);
        break;
      }

      const iterStart = Date.now();
      const result = await callPlannerOnce(userPrompt, model, token, {
        v22: true,
        iteration: iter,
        prevCoverage: iter > 1 ? coverageHistory[coverageHistory.length - 1] : undefined,
        entryType,
        systemContextText,
        fewShotsText,
      });
      const iterElapsed = ((Date.now() - iterStart) / 1000).toFixed(1);
      coverageHistory.push(result.plan_coverage ?? 0);

      progress?.(
        `[MoA Planner] iter ${iter}/${effectiveMax} done (${iterElapsed}s): ` +
        `plan_coverage=${(result.plan_coverage ?? 0).toFixed(2)}, ` +
        `needs_replan=${result.needs_replan}, ` +
        `ask_user=${result.ask_user}`
      );

      lastResult = result;

      // 路径 C:ask_user 触发(P0-1 阶段先暂停 + 返回,P0-8 会接入 vscode_askQuestions UI)
      if (result.ask_user && iter >= 2) {
        progress?.(`[MoA Planner] ask_user triggered at iter ${iter} — pausing mini-loop (P0-8 will handle UI)`);
        break;
      }

      // 路径 A:自然收敛(plan_coverage >= 阈值 且 needs_replan=false)
      if ((result.plan_coverage ?? 0) >= config.coverageThreshold && !result.needs_replan) {
        progress?.(`[MoA Planner] CONVERGED at iter ${iter} (plan_coverage=${(result.plan_coverage ?? 0).toFixed(2)} >= ${config.coverageThreshold})`);
        break;
      }

      // needs_replan=false 但 coverage 不足(可能 LLM 判断任务简单不需要再迭代)
      if (!result.needs_replan) {
        progress?.(`[MoA Planner] converged at iter ${iter} (needs_replan=false, plan_coverage=${(result.plan_coverage ?? 0).toFixed(2)})`);
        break;
      }
    }

    if (!lastResult) {
      // 极端情况(循环一次都没跑)
      return undefined;
    }

    // 路径 B:强制收敛检查
    const finalCoverage = lastResult.plan_coverage ?? 0;
    const finalIter = coverageHistory.length;
    if (finalCoverage < config.coverageThreshold && finalIter >= effectiveMax) {
      // 在 clarified_task 末尾标注未完全收敛
      lastResult.clarified_task = lastResult.clarified_task + ' (planner 未完全收敛)';
      progress?.(
        `[MoA Planner] FORCED CONVERGE at iter ${finalIter} ` +
        `(plan_coverage=${finalCoverage.toFixed(2)} < ${config.coverageThreshold}, ` +
        `marked as "未完全收敛")`
      );
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    progress?.(
      `[MoA Planner] mini-loop done in ${elapsed}s (${finalIter} iter(s), ` +
      `final plan_coverage=${finalCoverage.toFixed(2)}, ` +
      `difficulty=${lastResult.difficulty}, ` +
      `process_language=${lastResult.process_language ?? '(default)'})`
    );

    return lastResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    progress?.(`[MoA Planner] failed: ${msg.substring(0, 100)} (continuing without Planner)`);
    // Planner 失败不阻塞流程，返回 undefined 让调用方走旧逻辑
    return undefined;
  }
}
