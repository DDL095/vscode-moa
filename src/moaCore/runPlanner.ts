/**
 * moaCore/runPlanner.ts — v0.15.0 Planner 角色（任务理解 + 规划）
 *
 * 职责：把用户的原始 prompt 去模糊化、拆解子问题、给 Recon 提供初始方向。
 * 调用时机：orchestrate 首轮（iteration 0），仅一次。
 *
 * 设计哲学：
 *   - Planner 不调工具，纯推理
 *   - 用强推理模型（fallback 到 aggregator）
 *   - 失败不阻塞流程（fallback 到无 Planner 模式，直接 Recon）
 */

import * as vscode from 'vscode';
import { buildPlannerPrompt, extractJson, PlannerOutput } from './roles';
import { getActivePresetConfig } from '../presetConfig';

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
 * 调用 Planner LLM（一次性）。
 *
 * @param userPrompt 用户的原始任务
 * @param token      取消令牌
 * @param progress   进度回调（可选）
 * @returns PlannerOutput，失败时返回 undefined（调用方 fallback）
 */
export async function runPlanner(
  userPrompt: string,
  token: vscode.CancellationToken,
  progress?: (msg: string) => void
): Promise<PlannerOutput | undefined> {
  const start = Date.now();
  try {
    const model = await resolvePlannerModel();
    progress?.(`[MoA Planner] using ${model.name}`);

    const { system, user } = buildPlannerPrompt(userPrompt);
    const messages = [
      vscode.LanguageModelChatMessage.User(system + '\n\n---\n\n' + user),
    ];

    const response = await model.sendRequest(messages, {}, token);
    let raw = '';
    for await (const chunk of response.text) {
      raw += chunk;
    }

    const parsed = extractJson<PlannerOutput>(raw);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    progress?.(`[MoA Planner] done in ${elapsed}s (difficulty=${parsed.difficulty}, needs_iteration=${parsed.needs_iteration})`);

    // 防御性 normalize：确保数组字段是数组
    return {
      clarified_task: parsed.clarified_task || userPrompt,
      sub_questions: Array.isArray(parsed.sub_questions) ? parsed.sub_questions.slice(0, 5) : [],
      recon_hints: Array.isArray(parsed.recon_hints) ? parsed.recon_hints.slice(0, 8) : [],
      expected_output_format: parsed.expected_output_format || 'analysis',
      difficulty: parsed.difficulty || 'moderate',
      needs_iteration: typeof parsed.needs_iteration === 'boolean' ? parsed.needs_iteration : true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    progress?.(`[MoA Planner] failed: ${msg.substring(0, 100)} (continuing without Planner)`);
    // Planner 失败不阻塞流程，返回 undefined 让调用方走旧逻辑
    return undefined;
  }
}
