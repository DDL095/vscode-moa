/**
 * moaCore/runRecon.ts — v0.15.0 Recon 角色（调工具收集证据）
 *
 * v0.18.0: 支持并行多模型 Recon + 纯 LLM 整合（Recon Aggregator）
 *
 * 复用 src/actingAgent.ts 的 runReconAgent（read-only acting agent loop）。
 *
 * 调用时机：orchestrate 每轮 iteration 都跑（用户决策：Recon 每轮必跑）。
 *
 * 设计哲学：
 *   - Recon 是一个小 loop（内部多轮工具调用，有饱和检测）
 *   - 失败不阻塞流程（返回 error 字段，调用方决定是否继续）
 *   - 量大管饱模型（fallback 到 aggregator）
 *
 * v0.18.0 并行模式：
 *   - preset.reconModels 数组（>= 2 个）+ moa.parallelRecon=true → 并行
 *   - N 个 Recon 各自跑完整的 read-only agent loop（独立工具调用）
 *   - N 份结果由 Recon Aggregator 纯 LLM 整合（无工具权限）成单一 summary
 *   - 整合原则：完整无偏差（去重 + 整合 + 排序，不丢、不补、不重新查询）
 *   - 仅 1 个模型 或 parallelRecon=false → 退化为单模型模式（无 Recon Aggregator）
 */

import * as vscode from 'vscode';
import {
  buildReconPrompt,
  ReconReason,
  ReconResult,
  PlannerOutput,
  ReconAggregatorRoleSetup,
} from './roles';
import { getActivePresetConfig } from '../presetConfig';
import { runReconAgent } from '../actingAgent';
import type { ReconConfig } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// v0.18.0: 并行 Recon 返回类型
// ─────────────────────────────────────────────────────────────────────────

/**
 * 单个并行 Recon 的结果记录。
 * 与单模式 ReconResult 的区别：带 model 名（用于落盘 + 日志）。
 */
export interface ParallelReconResult {
  /** 该 Recon 的 label（如 "recon_1"），用于落盘文件名。 */
  label: string;
  /** 该 Recon 用的模型名（vscode.lm 的 m.name）。 */
  model: string;
  /** 完整的 ReconResult（summary + tool_calls + log 等）。 */
  result: ReconResult;
}

/**
 * v0.18.0: callRecon 的扩展返回类型（向后兼容）。
 *
 * - 单模型模式（parallelRecon=false 或 reconModels.length<=1）：
 *   返回 { mode: 'single', result: ReconResult }
 * - 并行模式：
 *   返回 { mode: 'parallel', results: ParallelReconResult[], merged: ReconResult, aggregatorModel: string }
 *
 * 调用方（moaOrchestrator.ts）根据 mode 决定：
 *   - 单模式：直接把 result.summary 推入 evidence
 *   - 并行模式：把 merged.summary 推入 evidence（已整合），同时把 results[] 落盘到 iteration/recon/
 */
/**
 * v0.18.0 方案 B：统一返回结构。
 *
 * 无论单/并行模式，都经过 Recon Aggregator 整合，都有 merged 字段。
 * mode 仅用于告知调用方"是否真的跑了多个模型"（影响落盘策略：
 * parallel 落盘 recon/ 子目录，single 不落盘）。
 *
 * 设计哲学：下游 refs 永远只看 merged.summary（经过标准化整合的），
 * 不需要关心上游是几个模型。
 */
export interface CallReconResult {
  /**
   * 'parallel' = 跑了多个 recon 模型（应落盘 recon/<label>.json）
   * 'single'   = 只跑了 1 个（不需要 recon/ 子目录）
   * 无论哪种，merged 都经过 Aggregator 整合。
   */
  mode: 'single' | 'parallel';
  /** 所有并行（或单个）recon 的完整结果。 */
  results: ParallelReconResult[];
  /** Recon Aggregator 整合后的单一 summary（注入下游 evidence）。 */
  merged: ReconResult;
  /** Recon Aggregator 用的模型名（失败时为 '(fallback concatenation)' 等）。 */
  aggregatorModel: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Model resolution
// ─────────────────────────────────────────────────────────────────────────

/**
 * 解析单个 ReconConfig → vscode.lm 模型。
 * model='' 时 fallback 到 aggregator。
 *
 * @param cfg      ReconConfig（可能 model 为空）
 * @param all      vscode.lm.selectChatModels 结果
 * @param real     过滤掉 placeholder 后的可用模型列表
 * @param aggCfg   aggregator 配置（用于 fallback）
 * @returns 解析到的模型，或 undefined（调用方处理）
 */
function resolveOneReconModel(
  cfg: ReconConfig,
  real: vscode.LanguageModelChat[],
  aggModelKey: string
): vscode.LanguageModelChat | undefined {
  // 1. 显式配置
  if (cfg.model && cfg.model.trim().length > 0) {
    const m = real.find((x) => (x.id ?? '') === cfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(cfg.model.toLowerCase()));
    if (m) return m;
  }
  // 2. Fallback：aggregator
  if (aggModelKey) {
    const m = real.find((x) => (x.id ?? '') === aggModelKey)
           ?? real.find((x) => x.name.toLowerCase().includes(aggModelKey.toLowerCase()));
    if (m) return m;
  }
  return undefined;
}

/**
 * 解析所有 Recon 模型（并行用）。
 *
 * 返回 label + model 对（label 用于落盘文件名，避免重名）。
 * 失败的模型不进数组（调用方按数组长度决定是否并行）。
 */
async function resolveAllReconModels(): Promise<Array<{ label: string; model: vscode.LanguageModelChat }>> {
  const all = await vscode.lm.selectChatModels({});
  const PLACEHOLDER = new Set(['auto', 'automatic', 'default', '']);
  const real = all.filter((m) => !PLACEHOLDER.has(m.name.toLowerCase().trim()));

  const activePreset = getActivePresetConfig();
  if (activePreset.isEmpty) {
    throw new Error('No preset configured.');
  }

  const reconCfgs = activePreset.reconModels;
  const aggModelKey = activePreset.aggregator?.model ?? '';

  const resolved: Array<{ label: string; model: vscode.LanguageModelChat }> = [];
  for (let i = 0; i < reconCfgs.length; i++) {
    const cfg = reconCfgs[i];
    const m = resolveOneReconModel(cfg, real, aggModelKey);
    if (m) {
      const label = reconCfgs.length === 1
        ? 'recon'
        : `recon_${i + 1}`;
      resolved.push({ label, model: m });
    }
  }

  if (resolved.length === 0) {
    // 最终 fallback：第一个可用模型
    if (real.length > 0) {
      resolved.push({ label: 'recon', model: real[0] });
    } else {
      throw new Error('No usable model for Recon.');
    }
  }

  return resolved;
}

/**
 * 解析 Recon Aggregator 模型（fallback 到主 aggregator）。
 */
async function resolveReconAggregatorModel(): Promise<vscode.LanguageModelChat> {
  const all = await vscode.lm.selectChatModels({});
  const PLACEHOLDER = new Set(['auto', 'automatic', 'default', '']);
  const real = all.filter((m) => !PLACEHOLDER.has(m.name.toLowerCase().trim()));

  const activePreset = getActivePresetConfig();
  if (activePreset.isEmpty) {
    throw new Error('No preset configured.');
  }

  // 1. reconAggregator 显式配置
  const reconAggCfg = activePreset.reconAggregator;
  if (reconAggCfg?.model && reconAggCfg.model.trim().length > 0) {
    const m = real.find((x) => (x.id ?? '') === reconAggCfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(reconAggCfg.model.toLowerCase()));
    if (m) return m;
  }

  // 2. Fallback：主 aggregator
  const aggCfg = activePreset.aggregator;
  if (aggCfg?.model) {
    const m = real.find((x) => (x.id ?? '') === aggCfg.model)
           ?? real.find((x) => x.name.toLowerCase().includes(aggCfg.model.toLowerCase()));
    if (m) return m;
  }

  if (real.length > 0) return real[0];
  throw new Error('No usable model for Recon Aggregator.');
}

// ─────────────────────────────────────────────────────────────────────────
// Recon Aggregator prompt（纯 LLM 整合，无工具权限）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 构建 Recon Aggregator 的 prompt。
 *
 * 设计：agent 化整合（有 full 工具权限），但工具用途严格约束。
 *   - 输入：N 份 Recon 的完整 summary
 *   - 输出：单一 merged summary（去重 + 整合 + 排序）
 *   - 工具用途：仅限整合内容所需的辅助操作
 *     ✅ 允许：读已引用文件确认细节、读 recon 提到的 URL 复核、写合并产物到 .moa_cache/
 *     ❌ 禁止：重新做 reconnaissance（新 web search / 学术搜索 / 探索性 grep）
 *     ❌ 禁止：修改用户的源文件
 */
function buildReconAggregatorPrompt(params: {
  task: string;
  iteration: number;
  reason: ReconReason;
  reconResults: Array<{ label: string; model: string; summary: string }>;
  /**
   * v0.22.0 P0-4: Planner 驱动模式下的 role_setup。
   * - undefined(默认) → 走内置静态 prompt(default 模式)
   * - 提供            → 拼到 system prompt 开头(planner 模式)
   *
   * 双轨制由配置项 moa.reconAggregatorMode 控制,callRecon 调用方根据
   * mode 决定是否传入 roleSetup。
   */
  roleSetup?: ReconAggregatorRoleSetup;
  /**
   * v0.22.0 P0-9: 自迭代时,把上一轮的整合结果注入,供模型"在上一轮基础上改进"。
   * undefined → 单次模式(默认)
   */
  previousSummary?: string;
  /** v0.22.0 P0-9: 当前自迭代号(从 1 开始),显示在 prompt 头部供模型感知。 */
  iterationNumber?: number;
}): { system: string; user: string } {
  const { task, iteration, reason, reconResults, roleSetup, previousSummary, iterationNumber } = params;

  // v0.22.0 P0-4: 双轨制 — roleSetup 非空时,把 Planner 定制的 tone/perspective/focus
  //                拼到 system prompt 开头
  const roleSetupBlock: string[] = [];
  if (roleSetup) {
    roleSetupBlock.push('=== ROLE SETUP (Planner 定制) ===');
    if (roleSetup.tone) {
      const toneLabel: Record<NonNullable<ReconAggregatorRoleSetup['tone']>, string> = {
        'faithful-integrator': '忠实整合(默认):保留原证据,做去重/排序/识别与保留冲突',
        'strict-evidence': '严谨证据:严格保留所有数字/引用/关键句,不做任何整合性推理',
        'creative-explorer': '创造探索:鼓励识别跨 recon 的隐性主题',
        'conservative': '保守模式:仅做最小去重,尽量保留原文',
      };
      roleSetupBlock.push(`Tone: ${roleSetup.tone} — ${toneLabel[roleSetup.tone] ?? ''}`);
    }
    if (roleSetup.perspective) {
      roleSetupBlock.push(`Perspective: ${roleSetup.perspective}`);
    }
    if (roleSetup.focus && roleSetup.focus.length > 0) {
      roleSetupBlock.push(`Focus: ${roleSetup.focus.join(' / ')}`);
    }
    roleSetupBlock.push('');
    roleSetupBlock.push('(以上是 Planner 根据任务属性定制的整合风格,优先尊重;若与下方默认原则冲突,以定制为准)');
    roleSetupBlock.push('');
  }

  const system = [
    '你是 MoA 流水线的 Recon Aggregator（侦察整合者）—— 一个 agent 化的整合者。',
    '',
    '## 核心职责',
    '',
    '把 N 个并行 Recon agent 的结果**整合成一份完整的 summary**，',
    '注入下游 Refs/Aggregator 作为 evidence。',
    '',
    '## 整合原则（v0.22.0 P0-4 v2 — 对齐用户"识别与保留冲突"哲学）',
    '',
    '**完整无偏差 + 识别与保留冲突**：',
    '- 保留所有证据（不丢、不删减）',
    '- 去重：完全相同的内容只保留一份（标注多个来源）',
    '- 排序：按对任务的相关性排序（最相关的放前面）',
    '- 标注来源：每条证据标注 [from <label>]（如 [from recon_1]）',
    '- **识别与保留冲突**：多 Recon 间说法不一致时,**保留两边** + 标注 "[冲突] A vs B"',
    '  (不要强行"消歧"——冲突是 Refs 分析的重要素材,Refs 自己决定哪边更可信)',
    '- **缺口识别**：所有 recon 都没覆盖的主题,显式列出 "[缺口] X 主题未查"',
    '- **证据质量分级**：每条证据标注 [high/medium/low] confidence(基于来源权威性)',
    '',
    '## 工具使用（严格限制）',
    '',
    '你有 full 工具权限（read + write），但**工具用途严格限制在整合所需的辅助操作**：',
    '',
    '✅ **允许的工具用途**：',
    '- 读 recon 引用的文件确认细节（如多个 recon 引用同一文件的不同行号，你读该文件确认）',
    '- 读 recon 提到的 URL 复核内容（仅限 recon 已引用的，不主动发现新 URL）',
    '- 读 recon 提到的代码符号/函数确认定义',
    '- 必要时把 merged summary 写到 .moa_cache/<task_id>/recon_merged.md（便于审计）',
    '',
    '❌ **禁止的工具用途**：',
    '- 新 web search / 学术搜索（这是 reconnaissance，不是 integration）',
    '- 新探索性 grep / find_files（同上）',
    '- fetch 新网页（recon 没引用的）',
    '- 修改用户的源文件（read-only on user sources）',
    '- 任何"补 gap"的动作（gap 是下一轮 Recon 的事）',
    '',
    '**判断准则**：工具调用应该是"查证已有引用"，而不是"发现新信息"。',
    '如果你发现自己在"探索"，立即停止调工具，开始整合。',
    '',
    '## 禁止行为（即使有工具）',
    '',
    '- ❌ 不要补 gap（gap 是下一轮 Recon 的事）',
    '- ❌ 不要做分析（分析是 Refs 的事）',
    '- ❌ 不要总结成 brief（Refs 需要完整内容做 grounded analysis）',
    '- ❌ 不要强行消歧(冲突留给 Refs 判断)',
    '',
    '你的角色是**搬运工 + 整理者 + 查证者**，不是分析师，也不是侦察员。',
    '把 N 份原料整理成一份完整、无偏差、易读的原料库。',
    '',
    '## 输出格式（Markdown）',
    '',
    '```',
    '## Recon 综合摘要 (iteration {N}, merged from {M} sources)',
    '',
    '<整合后的完整证据,按主题/相关性分节,每条带 confidence 标注>',
    '',
    '### 主题 1',
    '',
    '- 证据点 A [high] (来源: [from recon_1], [from recon_2])',
    '  <完整内容>',
    '- 证据点 B [medium] (来源: [from recon_2])',
    '  <完整内容>',
    '',
    '### 主题 2',
    '',
    '...',
    '',
    '## 冲突点(保留,不消歧)',
    '',
    '- [冲突] recon_1 说 X,recon_2 说 Y(让下游 Refs 判断)',
    '',
    '## 全局缺口(识别但保留)',
    '',
    '- [缺口] <所有 recon 都没查到的>(让 Aggregator 标记为 critical_gap)',
    '```',
    '',
    '匹配任务语言（中文任务 → 中文输出）。',
  ].join('\n');

  // v0.22.0 P0-4: 拼装最终 system — roleSetup 非空时拼到开头,否则直接用默认 system
  const finalSystem = roleSetupBlock.length > 0
    ? roleSetupBlock.join('\n') + '\n' + system
    : system;

  const userParts: string[] = [
    '### 任务',
    task,
    '',
    `### 本轮 Recon 上下文（iteration ${iteration}, reason: ${reason}）`,
    `收到 ${reconResults.length} 份并行 Recon 结果，请整合。`,
    '',
    '### Recon 结果列表',
    '',
  ];

  for (const r of reconResults) {
    userParts.push(`#### ${r.label} (model: ${r.model})`);
    userParts.push('```');
    userParts.push(r.summary || '(empty)');
    userParts.push('```');
    userParts.push('');
  }

  userParts.push('请按整合原则处理:完整无偏差、去重、排序、识别与保留冲突、缺口识别、证据质量分级。');
  userParts.push('如需查证已有引用的细节，可调工具；但禁止重新做侦察。');

  // v0.22.0 P0-9: 自迭代时,把上一轮 summary 注入,让模型在基础上改进
  if (previousSummary && iterationNumber && iterationNumber > 1) {
    userParts.push('');
    userParts.push(`## 上一轮整合结果(iter ${iterationNumber - 1})`);
    userParts.push('');
    userParts.push('请基于上一轮结果改进:');
    userParts.push('- 保留所有原始证据(完整无偏差)');
    userParts.push('- 修正整合不充分的地方(去重、排序、缺口识别)');
    userParts.push('- 显式标注与上一轮的差异');
    userParts.push('');
    userParts.push('```');
    userParts.push(previousSummary.slice(0, 6000));  // 截断防爆 token
    userParts.push('```');
  }

  return { system: finalSystem, user: userParts.join('\n') };
}

/**
 * 调用 Recon Aggregator（agent 化整合，full 工具权限但用途受限）。
 *
 * v0.18.0: 改用 runActingAgent（full 工具），而非纯 LLM 调用。
 * 工具用途由 prompt 严格约束（查证 vs 侦察）。
 *
 * v0.22.0 P0-4: 新增可选 roleSetup 参数,实现双轨制:
 *   - moa.reconAggregatorMode='default'(默认) → roleSetup=undefined,走内置 prompt
 *   - moa.reconAggregatorMode='planner'        → roleSetup 来自 Planner 的 role_setup.recon_aggregator
 *   P0-1 落地后,callRecon 调用方会根据 PlannerOutput 决定是否传入。
 */
async function callReconAggregator(
  params: {
    task: string;
    iteration: number;
    reason: ReconReason;
    reconResults: ParallelReconResult[];
    /** v0.22.0 P0-4: Planner 驱动模式下的 role_setup(可选) */
    roleSetup?: ReconAggregatorRoleSetup;
  },
  token: vscode.CancellationToken,
  progress?: (msg: string) => void,
  toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<{
  summary: string;
  model: string;
  elapsed_sec: number;
  tool_calls: number;
  /** v0.22.0 P0-9: 自迭代次数(默认 1,max 10) */
  iterationsRun: number;
  /** v0.22.0 P0-9: 聚合度评分(0-1,仅 >1 次时计算) */
  aggregationScore?: number;
  /** v0.22.0 P0-9: 忠诚度评分(0-1,仅 >1 次时计算) */
  fidelityScore?: number;
}> {
  const start = Date.now();
  const model = await resolveReconAggregatorModel();
  progress?.(`[MoA Recon Aggregator] merging ${params.reconResults.length} recon results with ${model.name} (agent mode${params.roleSetup ? ', planner-driven' : ''})...`);

  // v0.22.0 P0-9: 读取自迭代配置 + 收敛阈值(仅 maxIterations>1 时启用评分)
  const cfg = vscode.workspace.getConfiguration('moa');
  const maxIters = Math.min(10, Math.max(1, cfg.get<number>('reconAggregatorMaxIterations') ?? 1));
  const scoreThreshold = cfg.get<number>('reconAggregatorScoreThreshold') ?? 0.85;
  const useScoring = maxIters > 1;

  let bestSummary = '';
  let bestAggregationScore = 0;
  let bestFidelityScore = 0;
  let iterationsRun = 0;
  let totalToolCalls = 0;

  for (let iter = 1; iter <= maxIters; iter++) {
    iterationsRun = iter;
    if (token.isCancellationRequested) {
      progress?.(`[MoA Recon Aggregator] cancelled at iteration ${iter}`);
      break;
    }

    const { system, user } = buildReconAggregatorPrompt({
      task: params.task,
      iteration: params.iteration,
      reason: params.reason,
      reconResults: params.reconResults.map((r) => ({
        label: r.label,
        model: r.model,
        summary: r.result.summary,
      })),
      roleSetup: params.roleSetup,
      // v0.22.0 P0-9: 自迭代时,把上一轮的 summary 也注入 prompt
      previousSummary: iter > 1 ? bestSummary : undefined,
      iterationNumber: iter,
    });

    const { runActingAgent } = await import('../actingAgent');
    const agentResult = await runActingAgent(
      model,
      system,
      user,
      toolInvocationToken,
      createProgressOnlyStream((msg) => progress?.(`[MoA Recon Aggregator] ${msg}`)),
      token,
      {
        readOnly: false,
        maxIterations: 15,
        progressPrefix: 'MoA Recon Aggregator',
        captureToolResults: true,
      }
    );
    totalToolCalls += agentResult.capturedToolCalls?.length ?? 0;
    const candidateSummary = agentResult.output;
    progress?.(`[MoA Recon Aggregator] iter ${iter}/${maxIters} done (${candidateSummary.length} chars)`);

    if (!useScoring) {
      // 单次模式：直接返回,不需要评分
      bestSummary = candidateSummary;
      break;
    }

    // >1 次模式：评分 + 收敛判定
    const scores = scoreAggregation(candidateSummary, params.reconResults, iter);
    progress?.(
      `[MoA Recon Aggregator] iter ${iter} scores: ` +
      `aggregation=${scores.aggregation.toFixed(2)}, ` +
      `fidelity=${scores.fidelity.toFixed(2)}, ` +
      `min=${Math.min(scores.aggregation, scores.fidelity).toFixed(2)}`
    );

    if (scores.aggregation > bestAggregationScore) {
      bestAggregationScore = scores.aggregation;
      bestFidelityScore = scores.fidelity;
      bestSummary = candidateSummary;
    }

    const minScore = Math.min(scores.aggregation, scores.fidelity);
    if (minScore >= scoreThreshold) {
      progress?.(`[MoA Recon Aggregator] CONVERGED at iter ${iter} (min=${minScore.toFixed(2)} >= ${scoreThreshold})`);
      break;
    }
    if (iter === maxIters) {
      progress?.(`[MoA Recon Aggregator] reached maxIterations=${maxIters}, using best (min=${minScore.toFixed(2)})`);
    }
  }

  const elapsed = (Date.now() - start) / 1000;
  progress?.(
    `[MoA Recon Aggregator] done in ${elapsed.toFixed(1)}s, ${iterationsRun} iter(s), ` +
    `${totalToolCalls} tool calls, ${bestSummary.length} chars merged`
  );

  return {
    summary: bestSummary,
    model: model.name,
    elapsed_sec: elapsed,
    tool_calls: totalToolCalls,
    iterationsRun,
    aggregationScore: useScoring ? bestAggregationScore : undefined,
    fidelityScore: useScoring ? bestFidelityScore : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 主入口（v0.18.0 扩展版）
// ─────────────────────────────────────────────────────────────────────────

/**
 * v0.18.0 主入口：调用 Recon 角色（支持并行 + 整合）。
 *
 * 自动决策并行 vs 单模型：
 *   - reconModels.length >= 2 && moa.parallelRecon=true → 并行 + Recon Aggregator
 *   - 其他 → 单模型模式（行为同 v0.15-v0.17）
 *
 * 调用方根据返回的 mode 字段决定如何处理：
 *   - 'single'：直接用 result（兼容老代码）
 *   - 'parallel'：用 merged（已整合），同时把 results[] 落盘到 iteration/recon/
 *
 * @returns CallReconResult（discriminated union）
 */
export async function callRecon(
  params: {
    userPrompt: string;
    planner?: PlannerOutput;
    reason: ReconReason;
    gaps: string[];
    actorLog?: string;
    evidenceBrief: string;
    iteration: number;
    /**
     * v0.22.0 P0-4: Recon Aggregator 的 role_setup(可选,Planner 驱动模式)。
     *
     * 启用条件:moa.reconAggregatorMode='planner'(默认 'default')。
     * 调用方(moaOrchestrator.ts)负责根据配置项 + Planner 输出决定是否传入。
     * P0-4 阶段 PlannerOutput 还没有 role_setup 字段,P0-1 实施后才会真正传入。
     */
    reconAggregatorRoleSetup?: ReconAggregatorRoleSetup;
    /**
     * v0.22.0 P0-5: 基础设施层注入文本(由 systemContext.renderForRole('recon') 生成)。
     * 调用方缓存复用,空字符串时退化为 v0.21.x 行为。
     */
    systemContextText?: string;
    /**
     * v0.22.0 P0-5: Recon 角色身份层注入文本(Planner 的 role_setup.recon 渲染)。
     * P0-1 实施后由调用方构建。
     */
    roleSetupText?: string;
  },
  token: vscode.CancellationToken,
  progress?: (msg: string) => void,
  stream?: vscode.ChatResponseStream,
  toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<CallReconResult> {
  const resolvedModels = await resolveAllReconModels();

  // 读取并行开关 + v0.22.0 P0-4: Recon Aggregator 模式开关
  const config = vscode.workspace.getConfiguration('moa');
  const parallelRecon = config.get<boolean>('parallelRecon') ?? true;
  const reconAggregatorMode = config.get<'default' | 'planner'>('reconAggregatorMode') ?? 'default';

  // 决策：并行 or 单模型
  //   v0.18.0 方案 B：无论几个模型，都过 Aggregator（保证下游格式一致）
  //   v0.22.0 P0-4: 即使单 Recon 也跑 Aggregator(已由 v0.18.0 方案 B 实现),
  //                 本版本新增"始终落盘原始 Recon 产出"(由 moaOrchestrator 负责)
  //   区别仅在于：
  //     - 单模式：只跑 1 个 recon → Aggregator 整理（去噪、标准化格式）
  //     - 并行模式：跑 N 个 recon → Aggregator 去重、整合、标注来源
  const shouldParallel = parallelRecon && resolvedModels.length >= 2;

  // v0.22.0 P0-4: 根据 mode 决定是否使用 Planner 提供的 role_setup
  //   default 模式 → 不传(走内置 prompt)
  //   planner 模式 → 透传调用方提供的 roleSetup(P0-1 实施后才有值)
  const effectiveRoleSetup = reconAggregatorMode === 'planner'
    ? params.reconAggregatorRoleSetup
    : undefined;

  // ── 阶段 1：跑 Recon agent(s) ──
  // v0.22.0 P0-5: 透传 systemContextText + roleSetupText 给 buildReconPrompt
  const { system, user } = buildReconPrompt({
    userPrompt: params.userPrompt,
    planner: params.planner,
    reason: params.reason,
    gaps: params.gaps,
    actorLog: params.actorLog,
    evidenceBrief: params.evidenceBrief,
    iteration: params.iteration,
    systemContextText: params.systemContextText,
    roleSetupText: params.roleSetupText,
  });

  let parallelResults: ParallelReconResult[];
  if (shouldParallel) {
    // 并行模式
    progress?.(`[MoA Recon] iteration ${params.iteration}, reason=${params.reason}, running ${resolvedModels.length} recon agents in parallel...`);

    const reconPromises = resolvedModels.map((m) =>
      runSingleRecon(
        m.model,
        params,
        token,
        (msg) => progress?.(`[MoA Recon ${m.label}] ${msg}`),
        undefined,  // 并行时不传 stream（避免多 agent 抢 chat UI）
        toolInvocationToken,
        system,
        user
      ).then(
        (result) => ({ label: m.label, model: m.model.name, result }),
        (err) => {
          // 失败容错：包装成 error result（不抛错）
          const errMsg = err instanceof Error ? err.message : String(err);
          const failedResult: ReconResult = {
            summary: `(Recon ${m.label} failed: ${errMsg})`,
            tool_calls: 0,
            elapsed_sec: 0,
            early_stop_reason: 'error',
            log: [],
            error: errMsg,
          };
          return { label: m.label, model: m.model.name, result: failedResult };
        }
      )
    );
    parallelResults = await Promise.all(reconPromises);
    const successCount = parallelResults.filter((r) => !r.result.error).length;
    progress?.(`[MoA Recon] parallel done: ${successCount}/${parallelResults.length} succeeded`);
  } else {
    // 单模式
    const single = resolvedModels[0];
    progress?.(`[MoA Recon] iteration ${params.iteration}, reason=${params.reason}, model=${single.model.name} (single mode)`);
    const result = await runSingleRecon(
      single.model,
      params,
      token,
      progress,
      stream,
      toolInvocationToken
    );
    parallelResults = [{ label: single.label, model: single.model.name, result }];
  }

  // ── 阶段 2：全部失败检查 ──
  const successCount = parallelResults.filter((r) => !r.result.error).length;
  if (successCount === 0) {
    // 全部失败 → 返回 error summary（不调 Aggregator）
    const allErrors = parallelResults.map((r) => `${r.label}: ${r.result.error}`).join('; ');
    const failedMerged: ReconResult = {
      summary: `(All recon failed: ${allErrors})`,
      tool_calls: 0,
      elapsed_sec: 0,
      early_stop_reason: 'error',
      log: [],
      error: allErrors,
    };
    return {
      mode: shouldParallel ? 'parallel' : 'single',
      results: parallelResults,
      merged: failedMerged,
      aggregatorModel: '(none — all failed)',
    };
  }

  // ── 阶段 3：Recon Aggregator 整合（v0.18.0 方案 B：始终调用）──
  //   无论单/并行模式，都过 Aggregator 做一次"标准化整合"：
  //   - 单模式：Aggregator 帮 recon 的 raw 输出做去噪 + 结构化整理
  //   - 并行模式：Aggregator 去重 + 整合 + 标注来源
  //   保证下游 refs 看到的格式一致（无论上游是几个模型）
  const aggStart = Date.now();
  let mergedSummary = '';
  let aggregatorModelName = '';
  let aggregatorToolCalls = 0;
  try {
    const aggResult = await callReconAggregator({
      task: params.userPrompt,
      iteration: params.iteration,
      reason: params.reason,
      reconResults: parallelResults,
      roleSetup: effectiveRoleSetup,
    }, token, progress, toolInvocationToken);
    mergedSummary = aggResult.summary;
    aggregatorModelName = aggResult.model;
    aggregatorToolCalls = aggResult.tool_calls;
  } catch (err) {
    // Aggregator 失败 → fallback 到拼接（不丢证据）
    const msg = err instanceof Error ? err.message : String(err);
    progress?.(`[MoA Recon Aggregator] failed: ${msg.substring(0, 100)} — falling back to concatenation`);
    mergedSummary = parallelResults.map((r) =>
      `#### ${r.label} (model: ${r.model})\n\n${r.result.summary || '(empty)'}`
    ).join('\n\n---\n\n');
    aggregatorModelName = '(fallback concatenation)';
  }

  // 汇总 merged ReconResult
  //   tool_calls = 所有 recon 的总和 + Aggregator 自己的工具调用
  const totalToolCalls = parallelResults.reduce((sum, r) => sum + r.result.tool_calls, 0)
                       + aggregatorToolCalls;
  const merged: ReconResult = {
    summary: mergedSummary,
    tool_calls: totalToolCalls,
    elapsed_sec: (Date.now() - aggStart) / 1000,  // 简化：只算 Aggregator 阶段时间
    log: [],  // 并行模式的 log 在各 result 里，merged 不重复
  };

  return {
    // v0.18.0 方案 B：始终返回 'parallel' 结构（含 merged）
    //   mode 字段表示"是否真的并行了多个模型"（决定 orchestrator 是否落盘 recon/ 子目录）
    //   单模式时 mode='single' 但同样有 merged（Aggregator 整理过的）
    mode: shouldParallel ? 'parallel' : 'single',
    results: parallelResults,
    merged,
    aggregatorModel: aggregatorModelName,
  };
}

/**
 * 单模型 Recon 的核心执行（从原 callRecon 抽出，给并行模式复用）。
 *
 * @param customSystem  可选自定义 system prompt（v0.17.0+）
 * @param customUser    可选自定义 user prompt（v0.17.0+，与 system 配对）
 *                      若两者都未传，内部会调 buildReconPrompt 构建
 */
async function runSingleRecon(
  model: vscode.LanguageModelChat,
  params: {
    userPrompt: string;
    planner?: PlannerOutput;
    reason: ReconReason;
    gaps: string[];
    actorLog?: string;
    evidenceBrief: string;
    iteration: number;
    /** v0.22.0 P0-5: 仅在 fallback 路径(customSystem/customUser 未传)生效 */
    systemContextText?: string;
    /** v0.22.0 P0-5: 同上 */
    roleSetupText?: string;
  },
  token: vscode.CancellationToken,
  progress?: (msg: string) => void,
  stream?: vscode.ChatResponseStream,
  toolInvocationToken?: vscode.ChatParticipantToolToken,
  customSystem?: string,
  customUser?: string
): Promise<ReconResult> {
  const start = Date.now();

  const { system, user } = (customSystem && customUser)
    ? { system: customSystem, user: customUser }
    : buildReconPrompt(params);

  const reconResult = await runReconAgent(
    model,
    user,
    toolInvocationToken,
    stream ?? createProgressOnlyStream(progress),
    token,
    params.gaps,
    system
  );

  const elapsed = (Date.now() - start) / 1000;
  const toolCalls = reconResult.raw.capturedToolCalls?.length ?? 0;

  let summary = reconResult.summaryText;
  if (!summary || summary.trim().length === 0) {
    summary = buildSummaryFromCaptured(reconResult.raw.capturedToolCalls ?? []);
  }

  progress?.(`[MoA Recon] done in ${elapsed.toFixed(1)}s, ${toolCalls} tool calls, ${summary.length} chars`);

  return {
    summary,
    tool_calls: toolCalls,
    elapsed_sec: elapsed,
    early_stop_reason: reconResult.raw.hitIterationCap ? 'capped' :
                       reconResult.raw.error ? 'error' : undefined,
    log: (reconResult.raw.capturedToolCalls ?? []).map((c, i) => ({
      iteration: i + 1,
      tool_name: c.name,
      input_brief: typeof c.input === 'string'
        ? c.input.substring(0, 100)
        : JSON.stringify(c.input).substring(0, 100),
      result_chars: c.resultText.length,
      timestamp: new Date().toISOString(),
    })),
    error: reconResult.raw.error,
  };
}

/**
 * 从 capturedToolCalls 构建 summary（当 runReconAgent.summaryText 为空时）。
 */
function buildSummaryFromCaptured(
  captured: Array<{ name: string; resultText: string }>
): string {
  if (captured.length === 0) return '(Recon agent did not call any tools.)';
  const parts: string[] = ['## Recon 摘要（基于工具调用）', ''];
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    const preview = c.resultText.length > 500
      ? c.resultText.substring(0, 500) + '\n...(truncated)'
      : c.resultText;
    parts.push(`### ${i + 1}. ${c.name}`);
    parts.push('```');
    parts.push(preview);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * 当没有 chat stream 时，创建一个仅转发 progress 的 stream shim。
 * Recon agent 内部会 stream.markdown 流式输出，但 orchestrate 是 LM tool
 * 调用，没有 chat UI——此时用 progress 替代。
 */
function createProgressOnlyStream(
  progress?: (msg: string) => void
): vscode.ChatResponseStream {
  // 用类型断言绕过 Partial<ChatResponseStream> 的属性检查——
  // VSCode ChatResponseStream 是接口，运行时只需有 markdown/progress 即可
  const shim = {
    markdown(_msg: string) {
      // 静默吸收（recon 的中间 markdown 不需要转发到 LM tool 结果）
    },
    progress(msg: string) {
      progress?.(msg);
    },
  };
  return shim as unknown as vscode.ChatResponseStream;
}

// ─────────────────────────────────────────────────────────────────────────
// v0.22.0 P0-9: Recon Aggregator 评分（aggregation + fidelity）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 启发式评分：评估 Aggregator 输出的两个维度。
 *
 * 设计依据：
 *   - aggregationScore: 评估 Aggregator 是否充分整合多个 recon 输出
 *     （不简单拼接 = 把多份都提到；不过度归纳 = 没删关键证据）
 *   - fidelityScore: 评估 Aggregator 是否忠实保留原始 recon 的证据
 *     （关键词覆盖率 = 原 recon 中的事实/数字/引用在 aggregator 输出中出现比例）
 *
 * 注意：这是启发式（heuristic），不是 LLM-judge。优点：
 *   - 0 额外 LLM 调用（节省 token）
 *   - 确定性（同一输入永远得同一分数，便于回归测试）
 * 缺点：
 *   - 不评估"语义正确性"
 *   - 长 summary 自然得分高（长度偏差）
 *   - 仅用于"是否要再迭代一次"的粗筛
 *
 * 调用方（P0-9 mini-loop）：仅当 maxIterations > 1 时调用。
 */
function scoreAggregation(
  summary: string,
  reconResults: ParallelReconResult[],
  iter: number
): { aggregation: number; fidelity: number } {
  if (!summary || summary.length < 50) {
    return { aggregation: 0, fidelity: 0 };
  }

  const summaryLower = summary.toLowerCase();

  // ── 聚合度（aggregation）──
  //   启发：检查是否每个原始 recon 的"实质性内容"都被吸收。
  //   用最长的 50 个字符 window 作为"签名"，看 aggregator 输出是否包含这些签名。
  let totalSigs = 0;
  let matchedSigs = 0;
  for (const r of reconResults) {
    const raw = r.result.summary || '';
    if (!raw) continue;
    // 取每份 recon 的前 50 个非空字符作为签名
    const sig = raw.slice(0, 50).trim().toLowerCase();
    if (sig.length < 10) continue;
    totalSigs++;
    if (summaryLower.includes(sig.slice(0, 30))) {
      matchedSigs++;
    }
  }
  const aggregation = totalSigs > 0 ? matchedSigs / totalSigs : 0;

  // ── 忠诚度（fidelity）──
  //   启发：从每个 recon 抽取 5 个关键词（>= 3 字），看 aggregator 覆盖率
  let totalKeywords = 0;
  let matchedKeywords = 0;
  for (const r of reconResults) {
    const raw = r.result.summary || '';
    if (!raw) continue;
    // 抽取高频"内容词"（>= 4 字的英文/中文 token，跳过停用词）
    const tokens = (raw.match(/[\u4e00-\u9fa5]{2,8}|[a-zA-Z]{4,}/g) ?? [])
      .filter((t) => !STOPWORDS.has(t.toLowerCase()))
      .slice(0, 20);
    const uniqKeywords = Array.from(new Set(tokens)).slice(0, 5);
    for (const kw of uniqKeywords) {
      totalKeywords++;
      if (summaryLower.includes(kw.toLowerCase())) {
        matchedKeywords++;
      }
    }
  }
  const fidelity = totalKeywords > 0 ? matchedKeywords / totalKeywords : 0;

  // ── 长度惩罚：避免"越长越好"导致的过度迭代 ──
  const avgRawLen =
    reconResults.reduce((sum, r) => sum + (r.result.summary?.length ?? 0), 0) /
    Math.max(1, reconResults.length);
  const lengthRatio = summary.length / Math.max(1, avgRawLen);
  // summary 比原始还长 < 1.5x 加分，> 3x 视为可能过度展开
  const lengthBonus =
    lengthRatio < 1.5 ? 0.05 : lengthRatio > 3 ? -0.05 : 0;

  return {
    aggregation: Math.min(1.0, Math.max(0, aggregation + lengthBonus)),
    fidelity: Math.min(1.0, Math.max(0, fidelity + lengthBonus)),
  };
}

/** 评分用的英文停用词（避免常见词被当关键词）。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
  'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy',
  'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'with', 'this',
  'that', 'from', 'have', 'they', 'which', 'their', 'there', 'these',
  'those', 'would', 'could', 'should', 'about', 'because', 'them',
  'then', 'than', 'when', 'what', 'where', 'will', 'your', 'into',
]);
