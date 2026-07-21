/**
 * v0.22.0 P0-8: Plan Mode Report
 *
 * 设计目标（docs/moa-role-customization-blueprint-v2.md §10 + roadmap §P0-8）：
 *   - 触发时机：Planner mini-loop 收敛后
 *   - 展示内容：仅 Planner 状态（4 字段）—— **不含 token 估算**
 *     1. iterationsRun
 *     2. planCoverageHistory
 *     3. needsReplan
 *     4. askUserTriggered
 *   - 触发方式：vscode.askQuestions 风格的 dialog
 *   - 配置：moa.planModeReport.enabled（默认 true）
 *
 * 用户原话（v3 修订）：
 *   "Plan Mode 报告：vscode_askQuestions 显示，**只报告 Planner 状态**
 *    （iterationsRun / planCoverageHistory / needsReplan / askUserTriggered），
 *    **不要 token 消耗估算**"
 */

import * as vscode from 'vscode';

// ═════════════════════════════════════════════════════════════════════════
// 类型定义
// ═════════════════════════════════════════════════════════════════════════

/**
 * Plan Mode 报告数据结构。
 * 由 moaOrchestrator 在 Planner mini-loop 收敛后构建。
 */
export interface MoaPlanReport {
  /** 任务 id（用于关联 .moa_cache/）。 */
  task_id: string;
  /** mini-loop 实际跑的迭代数。 */
  iterationsRun: number;
  /** 每次迭代的 plan_coverage（数组）。 */
  planCoverageHistory: number[];
  /** 最终收敛状态。 */
  needsReplan: boolean;
  /** 是否在迭代中触发了 ask_user。 */
  askUserTriggered: boolean;
  /** 收敛原因：natural / max-iter / ask-user / disabled。 */
  convergedReason: 'natural' | 'max-iter' | 'ask-user' | 'disabled' | 'cancelled';
  /** mini-loop 总耗时（秒）。 */
  totalElapsedSec: number;
}

// ═════════════════════════════════════════════════════════════════════════
// 配置读取
// ═════════════════════════════════════════════════════════════════════════

/** 读取 planModeReport 开关（默认 true）。 */
export function isPlanModeReportEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration('moa');
  return cfg.get<boolean>('planModeReport.enabled') ?? true;
}

/** 切换开关并返回新值。 */
export async function togglePlanModeReport(): Promise<boolean> {
  const cur = isPlanModeReportEnabled();
  const next = !cur;
  await vscode.workspace
    .getConfiguration('moa')
    .update('planModeReport.enabled', next, vscode.ConfigurationTarget.Global);
  return next;
}

// ═════════════════════════════════════════════════════════════════════════
// 上次报告缓存（供 moa.showPlanModeReport 命令读取）
// ═════════════════════════════════════════════════════════════════════════

let _lastReport: MoaPlanReport | undefined;

/** moaOrchestrator 调用：设置当前任务的 Plan 报告。 */
export function setLastPlanReport(report: MoaPlanReport): void {
  _lastReport = report;
}

/** moaOrchestrator 调用：读取最近一次报告（用于 final.md 写入）。 */
export function getLastPlanReport(): MoaPlanReport | undefined {
  return _lastReport;
}

// ═════════════════════════════════════════════════════════════════════════
// Markdown 渲染（不含 token 估算）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 把 MoaPlanReport 渲染为 Markdown。
 *
 * **重要**：不含 token 消耗估算（用户原话 v3 修订）。
 * 仅展示 4 个 Planner 状态字段 + 收敛原因 + 耗时。
 */
export function renderPlanReportMarkdown(report: MoaPlanReport): string {
  const lines: string[] = [];
  lines.push('## 🧭 Plan Mode Report (Planner 状态)');
  lines.push('');
  lines.push(`> **task_id**: \`${report.task_id}\``);
  lines.push(`> **converged_reason**: ${report.convergedReason}`);
  lines.push(`> **iterationsRun**: ${report.iterationsRun}`);
  lines.push(`> **planCoverageHistory**: [${report.planCoverageHistory.map((c) => c.toFixed(2)).join(', ')}]`);
  lines.push(`> **needsReplan**: ${report.needsReplan}`);
  lines.push(`> **askUserTriggered**: ${report.askUserTriggered}`);
  lines.push(`> **totalElapsedSec**: ${report.totalElapsedSec.toFixed(1)}s`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**注**:本报告**不**包含 token 消耗估算（用户决策 v3）。');
  return lines.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
// 用户交互：vscode 风格的展示
// ═════════════════════════════════════════════════════════════════════════

/**
 * 在 untitled Markdown 文档中显示当前任务的 Plan Report。
 *
 * 触发场景：
 *   - 用户主动调 moa.showPlanModeReport 命令
 *   - Planner mini-loop 收敛后自动触发（如果开关启用）
 */
export async function showPlanModeReport(): Promise<void> {
  if (!_lastReport) {
    vscode.window.showInformationMessage('尚无 Plan Report。运行一次 @moa / @moaloop 后再试。');
    return;
  }
  const md = renderPlanReportMarkdown(_lastReport);
  const doc = await vscode.workspace.openTextDocument({
    content: md,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
